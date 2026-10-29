import { loadAgentSelectionConfig } from './agent-selection.js';
import { applyExecutionPolicy, resolveExecutionMode, type ExecutionMode, type ExecutionOptions } from './execution-policy.js';
import { responseLanguage } from './agent-context.js';
import { activeCliLanguage } from './cli-language.js';
import type { ResearchRequest, WebResearch } from './web-research.js';
import type { TaskKind } from './manager.js';
import path from 'node:path';

export type PlannerIntent = 'chat' | 'analyze_image' | 'web_research' | 'local_tool' | 'delegate_external';
export type PlannerCapability = 'text' | 'vision' | 'web' | 'file_read' | 'file_write' | 'terminal' | 'review';
export interface AgentPlan {
  responseContract?:'grounded_answer';
  answerResearch?:WebResearch;
  classification?: { source: 'gateway' | 'trained' | 'external'; model: string };
  planningUsage?: { tokens: number; costUsd?: number; estimated?: boolean };
  routingRequirements?: { task: TaskKind; difficulty?: number; minimumContextTokens?: number };
  version: '1.0'; intent: PlannerIntent; language: 'ja' | 'zh' | 'en'; text: string;
  operation?: 'answer' | 'read' | 'write'; research?: ResearchRequest;
  evidenceSource?: 'runtime' | 'workspace' | 'web' | 'none';
  targetPath?: string;
  runtimeRequirements?: Array<{ tool: string; operation?: string; resource?: string }>;
  attachments: Array<{ type: 'local_file'; path: string }>;
  requiredCapabilities: PlannerCapability[];
  tools: Array<'read_file' | 'list_files' | 'list_agent_sessions' | 'inspect_workspace_activity' | 'inspect_kubernetes' | 'write_file' | 'run_command' | 'web_research' | 'read_image'>;
  delegation: { enabled: boolean; parallel: boolean; requestedAgents: string[]; objective?: string };
  source: 'ai' | 'fallback' | 'explicit'; executionMode?: ExecutionMode; allowedWritePaths?: string[];
}

// 許可する値は構造化出力のスキーマ（Schema）です。自然言語のキーワード判定には使いません。
const intents = new Set<PlannerIntent>(['chat', 'analyze_image', 'web_research', 'local_tool', 'delegate_external']);
const capabilities = new Set<PlannerCapability>(['text', 'vision', 'web', 'file_read', 'file_write', 'terminal', 'review']);
const tools = new Set<AgentPlan['tools'][number]>(['read_file', 'list_files', 'list_agent_sessions', 'inspect_workspace_activity', 'inspect_kubernetes', 'write_file', 'run_command', 'web_research', 'read_image']);
const externalAgents = new Set(['ollama', 'lmstudio', 'goose', 'crush', 'kilo', 'opencode', 'hermes', 'claude', 'cline', 'openclaw']);

/** LLMの意味判断を採用し、形式・能力の整合性・許可範囲だけをコードで検証します。 */
export function validateAgentPlan(value: unknown, originalInput: string): AgentPlan {
  if (!value || typeof value !== 'object') throw new Error('Planner出力がオブジェクトではありません。');
  const row = value as Record<string, any>;
  // プランナー（Planner）は必要能力を宣言し、モデル選択はルーター（Router）へ委ねます。
  if (row.model !== undefined || row.provider !== undefined) throw new Error('Plannerはモデルまたはプロバイダー（Provider）を指定できません。');
  let routingRequirements: AgentPlan['routingRequirements'];
  if (row.routing_requirements !== undefined) {
    const requirements = row.routing_requirements;
    if (!requirements || typeof requirements !== 'object' || !['general', 'coding', 'reasoning', 'tool', 'vision'].includes(requirements.task)) throw new Error('ルーティング（Routing）のタスク種別が不正です。');
    if (requirements.difficulty !== undefined && (typeof requirements.difficulty !== 'number' || !Number.isFinite(requirements.difficulty) || requirements.difficulty < 0 || requirements.difficulty > 1)) throw new Error('難度（Difficulty）は0～1で指定してください。');
    if (requirements.minimum_context_tokens !== undefined && (!Number.isSafeInteger(requirements.minimum_context_tokens) || requirements.minimum_context_tokens < 0)) throw new Error('必要文脈長（Context）は非負整数で指定してください。');
    routingRequirements = { task: requirements.task, difficulty: requirements.difficulty, minimumContextTokens: requirements.minimum_context_tokens };
  }
  if (row.evidence_source !== undefined && !['runtime', 'workspace', 'web', 'none'].includes(row.evidence_source)) throw new Error('Plannerの証拠取得元が未対応です。');
  if (row.evidence_source === 'runtime' && (!Array.isArray(row.runtime_requirements) || !row.runtime_requirements.length || row.runtime_requirements.length > 4 || row.runtime_requirements.some((item: any) => !item || typeof item.tool !== 'string' || (item.operation !== undefined && typeof item.operation !== 'string') || (item.resource !== undefined && typeof item.resource !== 'string')))) throw new Error('実環境の取得に必要なruntime_requirementsを1～4件指定してください。');
  if (row.intent !== undefined && !intents.has(row.intent)) throw new Error('Plannerの意図が未対応です。');
  const intent: PlannerIntent = row.intent || 'chat';
  let requiredCapabilities: PlannerCapability[] = Array.isArray(row.required_capabilities)
    ? [...new Set(row.required_capabilities.filter((item: unknown): item is PlannerCapability => typeof item === 'string' && capabilities.has(item as PlannerCapability)))] : ['text'];
  let selectedTools: AgentPlan['tools'] = Array.isArray(row.tools)
    ? [...new Set(row.tools.filter((item: unknown): item is AgentPlan['tools'][number] => typeof item === 'string' && tools.has(item as AgentPlan['tools'][number])))] : [];
  if (row.operation !== undefined && !['answer', 'read', 'write'].includes(row.operation)) throw new Error('Plannerの操作種別が未対応です。');
  // 旧プラグインの計画は構造化された能力・ツールから種別を補完し、原文の単語には依存しません。
  const operation: NonNullable<AgentPlan['operation']> = row.operation || (selectedTools.includes('write_file') || requiredCapabilities.includes('file_write') ? 'write' : selectedTools.length ? 'read' : 'answer');
  if (operation !== 'write') {
    selectedTools = selectedTools.filter(item => item !== 'write_file');
    requiredCapabilities = requiredCapabilities.filter(item => item !== 'file_write');
  } else if (!selectedTools.includes('write_file') || !requiredCapabilities.includes('file_write')) {
    throw new Error('Plannerの書き込み計画に必要なツールまたは能力がありません。');
  }
  const delegation = row.delegation && typeof row.delegation === 'object' ? row.delegation : {};
  const plan: AgentPlan = {
    ...(routingRequirements ? { routingRequirements } : {}),
    version: '1.0', intent, operation, language: ['ja', 'zh', 'en'].includes(row.language) ? row.language : responseLanguage(originalInput), text: originalInput.trim(),
    attachments: Array.isArray(row.attachments) ? row.attachments.filter((item: any) => item?.type === 'local_file' && typeof item.path === 'string' && originalInput.includes(item.path)).slice(0, 4).map((item: any) => ({ type: 'local_file', path: item.path })) : [],
    requiredCapabilities: requiredCapabilities.length ? requiredCapabilities : ['text'], tools: selectedTools, evidenceSource: row.evidence_source,
    runtimeRequirements: row.evidence_source === 'runtime' ? row.runtime_requirements.map((item: any) => ({ tool: item.tool, operation: item.operation, resource: item.resource })) : undefined,
    delegation: { enabled: delegation.enabled === true, parallel: delegation.parallel === true,
      requestedAgents: Array.isArray(delegation.requested_agents) ? [...new Set<string>(delegation.requested_agents.map((item: unknown) => String(item).toLowerCase()).filter((item: string) => externalAgents.has(item)))].slice(0, 4) : [],
      objective: delegation.enabled === true ? originalInput.trim() : undefined }, source: 'ai',
  };
  if (row.target_path !== undefined) {
    if (typeof row.target_path !== 'string' || !path.win32.isAbsolute(row.target_path) || !originalInput.includes(row.target_path) || /[\0\r\n]/.test(row.target_path)) throw new Error('Plannerの作業先は依頼文に明示された絶対Pathを指定してください。');
    plan.targetPath = row.target_path;
  }
  if (row.execution_mode !== undefined) {
    if (!['auto', 'direct', 'delegate', 'propose'].includes(row.execution_mode)) throw new Error('Plannerの実行方式が未対応です。');
    plan.executionMode = row.execution_mode;
  }
  if (row.research !== undefined) {
    if (!row.research || !['weather', 'exchange', 'search', 'page'].includes(row.research.kind)) throw new Error('Plannerの調査種別が未対応です。');
    if (row.research.kind === 'weather' && typeof row.research.location !== 'string') throw new Error('天気調査の場所がありません。');
    if (row.research.kind === 'exchange' && (!Array.isArray(row.research.currencies) || row.research.currencies.length !== 2 || !row.research.currencies.every((item: unknown) => typeof item === 'string' && /^[A-Z]{3}$/.test(item)))) throw new Error('通貨コードの形式が不正です。');
    plan.research = row.research;
  }
  return applyExecutionPolicy(plan, originalInput);
}

/** 内部会話転送用の中立計画です。分類失敗時の実行には使わず、操作権限を付与しません。 */
export function fallbackAgentPlan(input: string): AgentPlan {
  return { version: '1.0', intent: 'chat', operation: 'answer', language: responseLanguage(input), text: input.trim(), attachments: [], requiredCapabilities: ['text'], tools: [], delegation: { enabled: false, parallel: false, requestedAgents: [] }, source: 'fallback' };
}

/** JSONの構文だけを解析します。自然言語の意味を推測しません。 */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return JSON.parse(fenced || text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

/** 依頼全体の意図・操作種別・実行方式・調査手段をLLMに判断させ、分類できなければ理由を返して停止します。 */
export function plannerSystemPrompt(): string {
  return `あなたは依頼分類専用のプランナーです。回答や実行はせず、依頼全体の文脈から意味を判断してJSONオブジェクトを1つだけ返してください。
${process.env.WENTIAN_RESPONSE_LANGUAGE || activeCliLanguage() ? `利用者の明示した既定の回答言語: ${process.env.WENTIAN_RESPONSE_LANGUAGE || activeCliLanguage()}。languageにはこの言語を設定してください。` : 'languageは現在の依頼と利用者の明示した希望から判断してください。'}
モデル名やプロバイダーは指定せず、routing_requirementsにtask（general,coding,reasoning,tool,vision）とdifficulty（0～1）を宣言してください。難度はタスク種別と独立に評価します。必要文脈長が明示された場合はminimum_context_tokensに非負整数を指定してください。品質予算はユーザーが指定するため推測しないでください。
形式: {"version":"1.0","intent":"chat","operation":"answer","evidence_source":"none","execution_mode":"auto","language":"ja","required_capabilities":["text"],"tools":[],"attachments":[],"delegation":{"enabled":false,"parallel":false,"requested_agents":[]}}
依頼文に作業先の絶対Pathが明示されていれば、場所の意味を判断してtarget_pathにそのPathだけを原文どおり指定してください。作業先の指定がない場合は省略してください。引用された過去のPathを現在の作業先にしないでください。
intentはchat,analyze_image,web_research,local_tool,delegate_external。operationはanswer（回答のみ）,read（情報取得・状況確認）,write（作成・変更）。execution_modeはauto,direct（直接実行・委譲禁止）,delegate,propose（提案のみ）。ユーザーが明示した方式を尊重してください。
能力はtext,vision,web,file_read,file_write,terminal,review。ツールはread_file,list_files,list_agent_sessions,inspect_workspace_activity,inspect_kubernetes,write_file,run_command,web_research,read_image。list_filesは資料探索、list_agent_sessionsはWentian自身の会話記録、inspect_workspace_activityは現在のワークスペースにあるGitコミット・変更状態の読み取り専用確認、inspect_kubernetesはget/top/describeを使う読み取り専用の実測です。会話で何を依頼・回答したかと、ワークスペースで何を変更したかは別の証拠源です。プロジェクト作業の報告ではinspect_workspace_activityでGit根拠を確認し、list_filesで関連する作業レポートを探してread_fileで内容を確認してください。会話履歴の報告ではlist_agent_sessionsを使ってください。対象の名前や接続先が不明ならまず資料を確認する計画にしてください。ツール一覧は実際の能力であり、スキルの有無は実行可否を決めません。
対象の名称や引用された過去の依頼を、今回の実行指示と混同しないでください。監視値や現在の利用率を尋ねる依頼は情報取得であり制作ではありません。リアルタイムの質問には取得に必要な能力を指定し、数値を推測しないでください。
evidence_sourceはruntime（実環境の現在値・稼働状況）,workspace（ファイルの内容）,web（外部Web情報）,none（一般知識）。利用率や稼働状況は過去の日付が明示されない限りruntimeとし、資料だけで現在値の取得が完了したと判断しないでください。
過去の作業報告では、対象が会話履歴かワークスペース作業かを意味から判定してください。会話履歴はoperation=read、evidence_source=runtime、toolsにlist_agent_sessions、runtime_requirementsに[{"tool":"list_agent_sessions"}]を指定します。プロジェクトの作業実績はevidence_source=workspaceとし、toolsにinspect_workspace_activity,list_files,read_fileを指定します。作業レポートの候補を探索して内容・日付を確認し、Git記録と照合してください。実行していない変更をGit差分だけで完了と断定せず、根拠の範囲と未確認事項を分けます。記録外の作業は確認できないことを回答に含めます。
runtimeの場合はruntime_requirementsに必要な観測を列挙してください。Kubernetesの使用量・利用率なら[{"tool":"inspect_kubernetes","operation":"top","resource":"pods"},{"tool":"inspect_kubernetes","operation":"get","resource":"pods"}]です。namespace一覧取得だけでは使用量の観測になりません。接続設定とnamespaceは資料確認後に回答モデルが選択します。
制作にはoperation=writeとfile_write能力、write_fileツールが必要です。情報取得・説明には書込みを付与しません。外部委譲が明示された場合や制作に適切な場合はdelegationを指定してください。対象エージェント名はユーザー指定を優先し、不明なら空配列にしてください。
Web調査はresearchを追加してください。天気は{"kind":"weather","location":"地名"}、為替は{"kind":"exchange","currencies":["USD","JPY"]}、一般検索は{"kind":"search","query":"検索文"}、指定ページは{"kind":"page","query":"URL"}。地名や通貨の解釈もあなたが行ってください。weatherのlocationはOpen-Meteoの地点検索へ送るため、利用者が指定した地点と同じ場所の一般的な英語地名へ正規化してください。回答言語は利用者の希望を維持してください。架空のパス・ツールを作らないでください。`;
}

export async function createAgentPlan(input: string, server: string, signal?: AbortSignal, options: ExecutionOptions = {}, dependencies: { classify?: typeof import('./planner-fallback.js').classifyWithExternalAgent; inferTrained?: typeof import('./planner-training.js').inferTrainedPlanner } = {}): Promise<AgentPlan> {
  const system = plannerSystemPrompt();
  let unavailable = false;
  const validated = (content: string, source: 'gateway' | 'trained' | 'external', model: string) => {
    const value = extractJson(content) as any;
    if (!value?.intent || !value?.operation) throw new Error('意図または操作種別がありません。');
    const plan = applyExecutionPolicy(validateAgentPlan(value, input), input, options);
    plan.classification = { source, model };
    return plan;
  };
  try {
    // 検証済み・明示有効化済みの自己学習モデルだけを優先し、失敗したらAPIへ戻します。
    if (!options.budget) {
      const { inferTrainedPlanner } = await import('./planner-training.js');
      const local = await (dependencies.inferTrained || inferTrainedPlanner)(system, input, signal);
      if (local) {
        try {
          const proposal = validated(local, 'trained', 'wentian-planner/lora');
          // 学習モデル（Trained Model）単独の誤判定で書き込み権限を付与しません。
          // 書き込み提案は既存の分類経路で元の依頼から再判定し、許可範囲の検査も維持します。
          if (proposal.operation !== 'write') return proposal;
        } catch { /* 不正出力はAPIへ代替します。 */ }
      }
    }
    const config = loadAgentSelectionConfig();
    const model = process.env.WENTIAN_PLANNER_MODEL?.trim() || config.planner.model;
    const deadline = AbortSignal.timeout(config.planner.timeoutMs);
    const messages = [{ role: 'system', content: system }, { role: 'user', content: input }];
    let lastError: unknown;
    let planningTokens=0,planningCost=0,estimated=false,costKnown=true;
    // モデルが形式を誤った場合は検証理由を同じLLMへ返して修正させます。意味をコードで補正しません。
    for (let attempt = 0; attempt < 3; attempt++) {
    const remainingTokens=options.budget?.maxTokens===undefined?undefined:options.budget.maxTokens-planningTokens;
    if(remainingTokens!==undefined&&remainingTokens<=0)throw new Error('分類用のトークン予算（Planner Token Budget）に到達しました。');
    const response = await fetch(`${server.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wentian-decision-kind': 'task-plan', 'x-wentian-execution-mode': resolveExecutionMode(input, options.mode), ...(process.env.WENTIAN_API_KEY ? { authorization: `Bearer ${process.env.WENTIAN_API_KEY}` } : {}) },
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 2048,
        ...(options.budget?{wentian_budget:{...options.budget,maxTokens:remainingTokens,...(options.budget.maxCostUsd!==undefined?{maxCostUsd:Math.max(0,options.budget.maxCostUsd-planningCost)}:{})}}:{}) }),
    }).catch(error => { unavailable = true; throw error; });
    if (!response.ok) {
      unavailable = [404, 408, 500, 502, 503, 504].includes(response.status);
      // 構造化されたAPIエラーだけを表示し、HTMLや応答本文全体の混入を防ぎます。
      const failure = await response.json().catch(() => undefined) as { error?: { message?: unknown; code?: unknown; type?: unknown; details?: { reason?: string; upstream?: { status?: number } } } } | undefined;
      if (response.headers.has('retry-after') || failure?.error?.type === 'rate_limit_exceeded' || failure?.error?.type === 'budget_exceeded'
        || failure?.error?.details?.reason === 'upstream_limit' || [401, 403, 429].includes(failure?.error?.details?.upstream?.status || 0)) unavailable = false;
      const detail = typeof failure?.error?.message === 'string' ? failure.error.message.slice(0, 500) : '';
      throw new Error(`HTTP ${response.status} 分類モデル=${model}${detail ? `: ${detail}` : ''}`);
    }
    const payload = await response.json() as any;
    if(options.budget){const observed=payload.wentian?.budget_tokens??payload.usage?.total_tokens;planningTokens+=typeof observed==='number'?observed:Buffer.byteLength(JSON.stringify(messages),'utf8')+2304;estimated||=typeof observed!=='number';
      if(typeof payload.wentian?.cost_usd==='number')planningCost+=payload.wentian.cost_usd;else costKnown=false;}
    const content = String(payload?.choices?.[0]?.message?.content || '');
    try {
      const value = extractJson(content) as any;
      if (process.env.WENTIAN_PLANNER_DEBUG === 'true') console.error('LLM分類の構造:', JSON.stringify({ attempt: attempt + 1, intent: value?.intent, operation: value?.operation }));
      if (!value?.intent || !value?.operation) throw new Error('意図または操作種別がありません。');
      const plan=validated(content, 'gateway', model);
      if(options.budget)plan.planningUsage={tokens:planningTokens,costUsd:costKnown?planningCost:undefined,estimated};
      return plan;
    } catch (error) {
      lastError = error;
      messages.push({ role: 'assistant', content: content.slice(0, 8000) }, { role: 'user', content: `The JSON failed validation: ${error instanceof Error ? error.message : String(error)}. Classify the ORIGINAL request again. Return exactly one JSON object. Required intent enum: "chat", "analyze_image", "web_research", "local_tool", "delegate_external". Required operation enum: "answer", "read", "write". Do not invent enum values. Use the complete schema from the system message.` });
    }
    }
    throw lastError;
  } catch (error) {
    if (signal?.aborted) throw error;
    // 認証・利用制限・予算エラーを外部接続で回避しません。APIが不通の場合だけ分類を代替します。
    if (unavailable && !options.budget && process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK !== 'false') {
      try {
        const { classifyWithExternalAgent } = await import('./planner-fallback.js');
        return await (dependencies.classify || classifyWithExternalAgent)(system, input, (content, agent) => validated(content, 'external', agent), signal);
      } catch (fallbackError) {
        if (signal?.aborted) throw fallbackError;
        throw new Error(`分類モデルとKilo/OpenCodeを利用できません。操作は開始していません。API: ${error instanceof Error ? error.message : String(error)} / ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`, { cause: fallbackError });
      }
    }
    throw new Error(`LLMによる依頼分類に失敗しました。操作は開始していません。分類モデルを確認して再試行してください。詳細: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
