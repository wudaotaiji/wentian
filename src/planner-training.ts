import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { renameWithRetry } from './atomic-file.js';
import { redactTrainingText } from './training-data.js';
import { plannerSystemPrompt, validateAgentPlan } from './agent-planner.js';
import { plannerTrainingPage } from './planner-training-ui.js';

export const plannerBaseModel = 'Qwen/Qwen2.5-0.5B-Instruct';
export const plannerBaseRevision = '7ae557604adf67be50417f59c2c2f167def9a775';
export function plannerTrainingRoot(): string { return process.env.WENTIAN_PLANNER_TRAINING_ROOT || path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), '.wentian', 'planner-training'); }
function python(): string { return process.env.WENTIAN_TRAINING_PYTHON || path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), '.wentian', 'planner-engine', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'); }
const engine = fileURLToPath(new URL('../scripts/train-planner.py', import.meta.url));
async function readJson(file: string): Promise<any> { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
function ownerAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) < 1) return false;
  try { process.kill(Number(pid), 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
async function save(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await renameWithRetry(temp, file);
}

/** 推論・学習とも固定スクリプトをシェル（Shell）なしで実行し、時間・出力上限を設けます。 */
export function runPlannerEngine(args: string[], input: string, timeout: number, signal?: AbortSignal, engineFile = engine, pythonExecutable = python()): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, [engineFile, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', TOKENIZERS_PARALLELISM: 'false' } });
    let output = '', errors = '', settled = false;
    const timer = setTimeout(() => { child.kill(); }, timeout); timer.unref();
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 2 * 1024 * 1024) child.kill(); });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
    child.stdin.on('error', () => { /* 起動失敗時のEPIPEは子プロセスのerrorで報告します。 */ });
    child.stdin.end(input);
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once('close', code => { clearTimeout(timer); if (settled) return; settled = true;
      if (code === 0 && output.length <= 2 * 1024 * 1024) resolve(output); else reject(new Error(`分類学習エンジンに失敗しました: code=${code} ${errors}`)); });
  });
}

/** 有効化は評価合格後だけ。推論エラーは既存API経路へ戻し、中断指示だけは伝播します。 */
export async function inferTrainedPlanner(system: string, input: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const active = await readJson(path.join(plannerTrainingRoot(), 'active.json'));
    if (!active?.id || !/^[a-f0-9-]{36}$/.test(active.id)) return;
    const directory = path.join(plannerTrainingRoot(), 'runs', active.id);
    const report = await readJson(path.join(directory, 'report.json'));
    if (report?.passed !== true) return;
    return await runPlannerEngine(['infer', '--directory', directory], JSON.stringify({ system, input }), 45000, signal);
  } catch (error) { if (signal?.aborted) throw error; return undefined; }
}

export class PlannerTrainingService {
  private queue: Promise<unknown> = Promise.resolve();
  private running?: Promise<void>;
  private runningId?: string;
  private controller?: AbortController;
  constructor(readonly root = plannerTrainingRoot(), readonly run = runPlannerEngine) {}
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.catch(() => undefined).then(action); this.queue = pending; return pending;
  }
  async status() {
    const data = await readJson(path.join(this.root, 'dataset.json')) || [];
    const names = await readdir(path.join(this.root, 'runs')).catch(() => [] as string[]);
    const runs = await Promise.all(names.filter(name => /^[a-f0-9-]{36}$/.test(name)).map(async id => {
      const job = await readJson(path.join(this.root, 'runs', id, 'job.json'));
      const lines = await readFile(path.join(this.root, 'runs', id, 'losses.jsonl'), 'utf8').catch(() => '');
      const curve = lines.trim().split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const result = job?.status === 'running' && id !== this.runningId && !ownerAlive(job.pid) ? { ...job, status: 'interrupted', error: '学習を管理するプロセスが終了しました。再実行してください。' } : job;
      return result ? { ...result, curve, progress: curve.at(-1) || null } : undefined;
    }));
    return { model: plannerBaseModel, examples: data.length, running: Boolean(this.running) || runs.some(job => job?.status === 'running'), managedHere: Boolean(this.running), active: await readJson(path.join(this.root, 'active.json')) || null,
      runs: runs.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), fallback: process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK !== 'false', python: python(),
      pythonAvailable: await stat(python()).then(info => info.isFile()).catch(() => false) };
  }
  /** 管理者が確認した正解だけ取り込みます。一般会話ログは正解ラベルとして流用しません。 */
  async importExamples(rows: unknown) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw new Error('確認済みの分類例を1〜1000件指定してください。');
    const normalized = rows.map(row => {
      if (!row || typeof row.input !== 'string' || !row.input.trim() || row.input.length > 8000) throw new Error('分類例の入力が不正です。');
      const input = redactTrainingText(row.input);
      // 秘密値を含むラベルも伏字化してから、実際の実行計画と同じ検証を適用します。
      const label = JSON.parse(redactTrainingText(JSON.stringify(row.label)));
      if (!label.intent || !label.operation) throw new Error('正解にはintentとoperationが必要です。');
      validateAgentPlan(label, input);
      if (row.split !== undefined && !['train', 'evaluation'].includes(row.split)) throw new Error('分割はtrainまたはevaluationで指定してください。');
      return { input, label, reviewed: true, ...(row.split ? { split: row.split } : {}) };
    });
    return this.exclusive(async () => {
      if (this.running) throw new Error('学習完了後にデータを追加してください。');
      const existing = await readJson(path.join(this.root, 'dataset.json')) || [];
      const byInput = new Map<string, unknown>(existing.map((row: any) => [row.input, row]));
      for (const row of normalized) byInput.set(row.input, row);
      if (byInput.size > 10000) throw new Error('分類例の上限は10000件です。');
      await save(path.join(this.root, 'dataset.json'), [...byInput.values()]); return { examples: byInput.size };
    });
  }
  async start(body: { steps?: number; allowDownload?: boolean; device?: string } = {}) {
    return this.exclusive(async () => {
      if ((await this.status()).running) throw new Error('学習は既に実行中です。');
      const steps = body.steps ?? 100;
      if (!Number.isSafeInteger(steps) || steps < 1 || steps > 2000 || !['auto', 'cpu', 'cuda'].includes(body.device || 'auto') || (body.allowDownload !== undefined && typeof body.allowDownload !== 'boolean')) throw new Error('学習条件が不正です。');
      const data = await readJson(path.join(this.root, 'dataset.json')) || [];
      if (data.length < 25) throw new Error('分類例を25件以上登録してください。少なくとも5件は未学習の評価用に分離します。');
      const id = randomUUID(), directory = path.join(this.root, 'runs', id);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'dataset.jsonl'), data.map((row: unknown) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
      const preparedPrompt = await readJson(path.join(this.root, 'training-prompt.json'));
      await save(path.join(directory, 'prompt.json'), { system: preparedPrompt?.system || plannerSystemPrompt() });
      const job = { id, status: 'running', pid: process.pid, createdAt: new Date().toISOString(), model: plannerBaseModel, revision: plannerBaseRevision, steps, seed: 42, device: body.device || 'auto', allowDownload: body.allowDownload === true };
      await save(path.join(directory, 'job.json'), job);
      this.controller = new AbortController();
      this.runningId = id;
      this.running = this.run(['train', '--directory', directory, '--steps', String(steps), '--device', job.device, ...(job.allowDownload ? ['--allow-download'] : [])], '', 6 * 3600000, this.controller.signal)
        .then(async () => {
          const report = await readJson(path.join(directory, 'report.json'));
          if (!report || typeof report.passed !== 'boolean') throw new Error('評価結果がありません。');
          await save(path.join(directory, 'job.json'), { ...job, status: report.passed ? 'succeeded' : 'rejected', finishedAt: new Date().toISOString(), report });
        }).catch(async error => { await save(path.join(directory, 'job.json'), { ...job, status: 'failed', finishedAt: new Date().toISOString(), error: redactTrainingText(String(error)) }); })
        .finally(() => { this.running = undefined; this.runningId = undefined; this.controller = undefined; });
      return job;
    });
  }
  async activate(id: string | null) {
    return this.exclusive(async () => {
      if (id === null) { await save(path.join(this.root, 'active.json'), null); return { active: null }; }
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('学習IDが不正です。');
      const directory = path.join(this.root, 'runs', id), job = await readJson(path.join(directory, 'job.json'));
      const report = await readJson(path.join(directory, 'report.json'));
      if (job?.status !== 'succeeded' || report?.passed !== true || report.evaluated < 5 || report.accuracy < 0.9 || report.unsafeWrites !== 0) throw new Error('未学習データの評価に合格したモデルだけ有効化できます。');
      if (!(await stat(path.join(directory, 'adapter', 'adapter_model.safetensors'))).isFile()) throw new Error('学習重みがありません。');
      await save(path.join(this.root, 'active.json'), { id, activatedAt: new Date().toISOString() }); return { active: id };
    });
  }
  async stop() { this.controller?.abort(); await this.running; }
}

/** 管理者の同一オリジン操作だけが学習データ・計算資源・有効モデルを変更できます。 */
export function registerPlannerTraining(app: FastifyInstance, authorize: (req: FastifyRequest, reply: FastifyReply) => string | undefined, service = new PlannerTrainingService()) {
  app.get('/model-training', async (_req, reply) => reply.type('text/html').send(plannerTrainingPage()));
  app.get('/api/planner-training', async (req, reply) => authorize(req, reply) ? service.status() : reply);
  const mutation = (action: (body: any) => Promise<unknown>) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authorize(req, reply)) return reply;
    if (req.headers['x-team-virtual-key'] || req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) return reply.code(403).send({ error: { message: '同一オリジンから操作してください。' } });
    try { return await action(req.body); } catch (error) { return reply.code(400).send({ error: { message: error instanceof Error ? error.message : String(error) } }); }
  };
  app.post('/api/planner-training/examples', mutation(body => service.importExamples(body?.examples)));
  app.post('/api/planner-training/runs', mutation(body => service.start(body || {})));
  app.post('/api/planner-training/active', mutation(body => service.activate(body?.id)));
  app.post('/api/planner-training/stop', mutation(async () => { await service.stop(); return service.status(); }));
  app.get('/api/planner-training/runs/:id/artifacts/:name', async (req, reply) => {
    if (!authorize(req, reply)) return reply;
    const { id, name } = req.params as { id: string; name: string };
    // 実ファイル名を固定し、任意のパスや資格情報を取得する入口にしません。
    const allowed = ['report.html', 'report.json', 'training-config.json', 'environment.json', 'requirements.lock.txt', 'dataset.jsonl', 'training.jsonl', 'evaluation.jsonl', 'losses.jsonl', 'predictions.jsonl', 'model-manifest.json', 'prompt.json', 'reproduction.zip'];
    if (!/^[a-f0-9-]{36}$/.test(id) || !allowed.includes(name)) return reply.code(404).send({ error: { message: '成果物がありません。' } });
    try {
      const content = await readFile(path.join(service.root, 'runs', id, name));
      // レポートには固定スクリプトとエスケープ済みデータだけを含めます。
      return reply.type(name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.zip') ? 'application/zip' : 'text/plain; charset=utf-8').send(content);
    } catch { return reply.code(404).send({ error: { message: '成果物はまだ生成されていません。' } }); }
  });
  app.addHook('onClose', () => service.stop()); return service;
}
