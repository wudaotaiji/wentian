/** ルーター（Router）はモデル選択を担当し、資源観測・状態変更は実行しません。 */
import { evaluateModelSafety, estimateModelRuntimeBytes, DEFAULT_SAFETY_POLICY, type ManagedModel, type MemorySnapshot, type CandidateRequest, type SafetyPolicy, type RankedCandidate } from './manager.js';

/** 能力、コンテキスト長、ロード状態、安全性を用いて候補を順位付けする。 */
export function rankModelCandidates(
  models: ManagedModel[],
  memory: MemorySnapshot,
  request: CandidateRequest,
  policy: SafetyPolicy = DEFAULT_SAFETY_POLICY,
): RankedCandidate[] {
  return models.map((model) => {
    const safety = evaluateModelSafety(model, memory, policy, request);
    const capabilities = model.capabilities ?? {};
    const scoreReasons: string[] = [];
    let score = safety.level === 'safe' ? 30 : safety.level === 'warning' ? 5 : -1000;
    if (model.loaded && request.preferLoaded !== false) { score += 25; scoreReasons.push('ロード済み +25'); }
    if(request.quality!==undefined){const footprint=model.estimatedRuntimeBytes??estimateModelRuntimeBytes(model);const weight={economy:3,balanced:0.3,quality:0.1,max:0}[request.quality];
      const penalty=Math.min(60,footprint/1024**3*weight)*(1-(request.difficulty??0.5));score-=penalty;scoreReasons.push(`算力予算（Compute Budget） -${penalty.toFixed(1)}`);}
    const taskKey = request.task === 'general' ? undefined : request.task;
    if (taskKey) {
      const taskScore = Math.max(0, Math.min(1, capabilities[taskKey] ?? 0.5));
      score += taskScore * 40;
      scoreReasons.push(`${taskKey} 能力 +${(taskScore * 40).toFixed(1)}`);
      if (request.difficulty !== undefined || request.quality !== undefined) {
        const qualityWeight = { economy: 10, balanced: 30, quality: 60, max: 100 }[request.quality ?? 'balanced'];
        const adjustment = taskScore * (qualityWeight + 40 * Math.max(0, Math.min(1, request.difficulty ?? 0.5)));
        score += adjustment;
        scoreReasons.push(`品質予算（Quality Budget）と難度（Difficulty） +${adjustment.toFixed(1)}`);
      }
    }
    if (request.requiresVision && !capabilities.vision) { score -= 500; scoreReasons.push('Vision 非対応 -500'); }
    if (request.requiresTool && !capabilities.tool) { score -= 500; scoreReasons.push('Tool 非対応 -500'); }
    if (request.minimumContextTokens) {
      if ((capabilities.contextTokens ?? 0) < request.minimumContextTokens) { score -= 500; scoreReasons.push('Context 不足 -500'); }
      else { score += 10; scoreReasons.push('Context 要件充足 +10'); }
    }
    // 必須能力はランキング（Ranking）の加点とは独立した適格性条件です。
    if ((request.requiresVision && !capabilities.vision) || (request.requiresTool && !capabilities.tool) ||
        (request.minimumContextTokens && (capabilities.contextTokens ?? 0) < request.minimumContextTokens)) {
      safety.level = 'blocked';
      safety.reasons.push('必須能力またはコンテキスト（Context）長を満たしません。');
    }
    const history = request.performance?.list({ model: model.id }).filter(item => item.task === request.task);
    if (history && history.length >= 3) {
      const successes = history.filter(item => item.success);
      const prediction = predictModelLatency(model.id, request);
      const latency = prediction ?? (successes.length ? successes.reduce((sum, item) => sum + item.latencyMs, 0) / successes.length : 0);
      const speedWeight = { economy: 40, balanced: 20, quality: 10, max: 5 }[request.quality ?? 'balanced'];
      const adjustment = 20 * successes.length / history.length - 20 + (successes.length ? speedWeight / (1 + latency / 1000) : 0);
      score += adjustment;
      scoreReasons.push(`タスク別実測性能（Runtime Performance） ${adjustment.toFixed(1)}：${history.length}件`);
      if (prediction !== undefined) scoreReasons.push(`生成時間予測（Runtime Prediction） ${prediction.toFixed(0)}ms`);
      const evaluated = history.filter(item => item.qualityAccepted !== undefined || item.verified !== undefined);
      if (evaluated.length >= 3) {
        const accepted = evaluated.filter(item => item.qualityAccepted !== false && item.verified !== false).length / evaluated.length;
        score += (accepted - 0.5) * 60;
        scoreReasons.push(`受入・検証評価（Evaluation） ${(accepted * 100).toFixed(0)}%`);
      }
    }
    return { model, safety, score, scoreReasons };
  }).sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));
}

/** TTFTと生成速度（TPS）を使い、要求した最大出力長に対する所要時間を予測します。 */
export function predictModelLatency(model: string, request: CandidateRequest): number | undefined {
  const items = request.performance?.list({ model }).filter(item => item.task === request.task && item.success && item.ttftMs !== undefined &&
    (item.outputTokens ?? 0) > 0 && item.latencyMs > item.ttftMs!) ?? [];
  if (items.length < 3) return undefined;
  const averageTtft = items.reduce((sum, item) => sum + item.ttftMs!, 0) / items.length;
  const tps = items.reduce((sum, item) => sum + item.outputTokens!, 0) / (items.reduce((sum, item) => sum + item.latencyMs - item.ttftMs!, 0) / 1000);
  const output = request.maxOutputTokens ?? items.reduce((sum, item) => sum + item.outputTokens!, 0) / items.length;
  return averageTtft + output / tps * 1000;
}

/** 未測定の品質を断定せず、タスク別の成功実績・能力と実メモリから個人向け候補を示します。 */
export function recommendModelPool(models: ManagedModel[], memory: MemorySnapshot, performance: CandidateRequest['performance']) {
  const tasks = ['general', 'coding', 'reasoning', 'tool', 'vision'] as const;
  return tasks.map(task => ({ task, observedRequests: performance?.list().filter(item => item.task === task).length ?? 0,
    candidates: rankModelCandidates(models, memory, { task, performance, requiresTool: task === 'tool', requiresVision: task === 'vision', preferLoaded: true })
      .filter(item => item.safety.level !== 'blocked').slice(0, 3).map(item => ({ model: item.model.id, score: item.score, reasons: item.scoreReasons,
        evidence: (performance?.list({ model: item.model.id }).filter(row => row.task === task).length ?? 0) >= 3 ? 'measured' : 'capability_only',
        requiredBytes: item.safety.requiredBytes, scope: item.model.metadata?.resourceScope })) }));
}

/** 昇格（Escalation）は登録能力または検証済み受入率が高い実行先だけに行います。 */
export function modelQuality(model: ManagedModel | undefined, task: CandidateRequest['task'], performance?: CandidateRequest['performance']): number {
  if (!model) return 0;
  const evaluated = performance?.list({ model: model.id }).filter(item => item.task === task && (item.qualityAccepted !== undefined || item.verified !== undefined)) ?? [];
  if (evaluated.length >= 3) return evaluated.filter(item => item.qualityAccepted !== false && item.verified !== false).length / evaluated.length;
  return model.capabilities?.[task] ?? 0.5;
}
