import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { renameWithRetry } from './atomic-file.js';
import { runPlannerEngine } from './planner-training.js';
import { redactTrainingText } from './training-data.js';
import { MailTaxonomyStore } from './mail-taxonomy.js';

type MailTask = 'classification' | 'extraction';
type MailRow = {
  mail_id: string; thread_id: string; duplicate_group_id: string;
  subject: string; body: string; reviewed: true; split?: 'train' | 'evaluation';
  label_path?: string[]; kind?: 'personnel' | 'project'; fields?: Record<string, string>;
};

const engine = fileURLToPath(new URL('../scripts/train-mail.py', import.meta.url));
const tasks: MailTask[] = ['classification', 'extraction'];
export { mailCategoryPaths } from './mail-taxonomy.js';
const root = () => process.env.WENTIAN_MAIL_TRAINING_ROOT || path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), '.wentian', 'mail-training');
const python = () => { const local=path.join(process.env.WENTIAN_INSTALL_ROOT||process.cwd(),'.wentian','mail-engine',process.platform==='win32'?'Scripts/python.exe':'bin/python');return process.env.WENTIAN_MAIL_TRAINING_PYTHON || (existsSync(local)?local:'python'); };
const taskValid = (value: unknown): value is MailTask => tasks.includes(value as MailTask);
const bounded = (value: unknown, max: number, name: string): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name}の長さが不正です。`);
  return value.trim();
};
async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}
async function saveJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await renameWithRetry(temporary, file);
}
function normalize(task: MailTask, value: unknown, taxonomy: MailTaxonomyStore): MailRow {
  if (!value || typeof value !== 'object') throw new Error('学習例はJSONオブジェクトで指定してください。');
  const row = value as Record<string, unknown>;
  if (row.reviewed !== true) throw new Error('人が確認した学習例だけ登録できます。');
  const mailId = bounded(row.mail_id, 160, 'メールID');
  const subject = redactTrainingText(bounded(row.subject ?? '', 1000, '件名'));
  const body = redactTrainingText(bounded(row.body ?? '', 19000, '本文'));
  if (!mailId || !/^[\w.:-]+$/.test(mailId) || !subject && !body) throw new Error('メールIDと件名または本文が必要です。');
  const threadId = bounded(row.thread_id ?? mailId, 160, '会話ID');
  const duplicateId = bounded(row.duplicate_group_id ?? threadId, 160, '重複群ID');
  if (!threadId || !duplicateId) throw new Error('会話・重複群IDを指定してください。');
  if (row.split !== undefined && row.split !== 'train' && row.split !== 'evaluation') throw new Error('分割はtrainまたはevaluationで指定してください。');
  const common: MailRow = { mail_id: mailId, thread_id: threadId, duplicate_group_id: duplicateId,
    subject, body, reviewed: true, ...(row.split ? { split: row.split as MailRow['split'] } : {}) };
  if (task === 'classification') {
    taxonomy.category(row.label_path);
    return { ...common, label_path: row.label_path as string[] };
  }
  if (row.kind !== 'personnel' && row.kind !== 'project') throw new Error('抽出対象はpersonnelまたはprojectです。');
  if (!row.fields || typeof row.fields !== 'object' || Array.isArray(row.fields)) throw new Error('正解項目fieldsを指定してください。');
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(row.fields)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name) || typeof value !== 'string' || !value.trim() || value.length > 300)
      throw new Error('抽出項目の名前または値が不正です。');
    if (!(subject + '\n' + body).includes(value.trim())) throw new Error(`正解項目${name}の値がメール本文に見つかりません。`);
    fields[name] = value.trim();
  }
  if (!Object.keys(fields).length) throw new Error('抽出用の正解項目がありません。');
  return { ...common, kind: row.kind, fields };
}

/** Planner と同じ学習ワーカー管理を使い、メール用の入出力と評価を独立させます。 */
export class MailTrainingService {
  private queue: Promise<unknown> = Promise.resolve();
  private running?: Promise<void>;
  private controller?: AbortController;
  constructor(readonly directory = root()) {}
  get taxonomy() { return new MailTaxonomyStore(path.join(this.directory, 'taxonomy.json')); }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.catch(() => undefined).then(action);
    this.queue = pending;
    return pending;
  }
  private dataset(task: MailTask): string { return path.join(this.directory, 'datasets', `${task}.json`); }
  async status() {
    const ids = await readdir(path.join(this.directory, 'runs')).catch(() => [] as string[]);
    const runs = (await Promise.all(ids.filter(id => /^[a-f0-9-]{36}$/.test(id)).map(async id => {
      const file=path.join(this.directory,'runs',id,'job.json');
      const job=await readJson<Record<string,unknown>|null>(file,null);
      if(job?.status==='running'&&!this.running){let alive=false;try{if(Number.isSafeInteger(job.ownerPid)){process.kill(Number(job.ownerPid),0);alive=true;}}catch{/* 終了済みの学習プロセスは再起動後も実行中として表示しません。 */}
        if(!alive){const interrupted:Record<string,unknown>={...job,status:'failed',finishedAt:new Date().toISOString(),error:'サーバー停止により学習が中断されました。再実行してください。'};await saveJson(file,interrupted);return interrupted;}}
      return job;
    }))).filter(Boolean);
    const datasets=Object.fromEntries(await Promise.all(tasks.map(async task=>{const rows=await readJson<MailRow[]>(this.dataset(task),[]);const normalized=rows.map(row=>JSON.stringify(row)).sort().join('\n');return [task,{count:rows.length,hash:createHash('sha256').update(normalized).digest('hex')}];})));
    return { python: python(), running: Boolean(this.running),
      examples: Object.fromEntries(Object.entries(datasets).map(([task,value])=>[task,(value as any).count])),datasetHashes:Object.fromEntries(Object.entries(datasets).map(([task,value])=>[task,(value as any).hash])),
      active: Object.fromEntries(await Promise.all(tasks.map(async task => [task, await readJson(path.join(this.directory, `active-${task}.json`), null)]))),
      runs: runs.sort((a, b) => String(b?.createdAt).localeCompare(String(a?.createdAt))) };
  }
  async importExamples(task: MailTask, examples: unknown) {
    if (!taskValid(task) || !Array.isArray(examples) || !examples.length || examples.length > 1000)
      throw new Error('分類または抽出の確認済み例を1〜1000件指定してください。');
    const rows = examples.map(row => normalize(task, row, this.taxonomy));
    return this.exclusive(async () => {
      if (this.running) throw new Error('学習完了後にデータを追加してください。');
      const current = await readJson<MailRow[]>(this.dataset(task), []);
      const byId = new Map(current.map(row => [row.mail_id, row]));
      for (const row of rows) byId.set(row.mail_id, row);
      if (byId.size > 10000) throw new Error('学習例の上限は10000件です。');
      await saveJson(this.dataset(task), [...byId.values()]);
      return { task, examples: byId.size };
    });
  }
  async start(task: MailTask) {
    if (!taskValid(task)) throw new Error('学習対象が不正です。');
    return this.exclusive(async () => {
      if (this.running) throw new Error('別の学習が実行中です。');
      const rows = await readJson<MailRow[]>(this.dataset(task), []);
      if (rows.length < 11) throw new Error('確認済みメールを11件以上登録してください。');
      const id = randomUUID(), directory = path.join(this.directory, 'runs', id);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'dataset.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
      const datasetHash=createHash('sha256').update(rows.map(row=>JSON.stringify(row)).sort().join('\n')).digest('hex');
      const job = { id, task, status: 'running', ownerPid:process.pid, datasetHash, createdAt: new Date().toISOString(), examples: rows.length };
      await saveJson(path.join(directory, 'job.json'), job);
      this.controller = new AbortController();
      this.running = runPlannerEngine(['train', '--task', task, '--directory', directory], '', 2 * 3600000,
        this.controller.signal, engine, python()).then(async () => {
          const report = await readJson<{ passed: boolean; score: number } | null>(path.join(directory, 'report.json'), null);
          if (!report) throw new Error('独立評価結果がありません。');
          await saveJson(path.join(directory, 'job.json'), { ...job, status: report.passed ? 'succeeded' : 'rejected',
            finishedAt: new Date().toISOString(), report });
        }).catch(async error => {
          await saveJson(path.join(directory, 'job.json'), { ...job, status: 'failed',
            finishedAt: new Date().toISOString(), error: redactTrainingText(String(error)) });
        }).finally(() => { this.running = undefined; this.controller = undefined; });
      return job;
    });
  }
  async activate(task: MailTask, id: unknown) {
    if (!taskValid(task) || typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('学習対象と実行IDが不正です。');
    return this.exclusive(async () => {
      const directory = path.join(this.directory, 'runs', id);
      const job = await readJson<{ task: MailTask; status: string } | null>(path.join(directory, 'job.json'), null);
      const report = await readJson<{ passed: boolean; score: number } | null>(path.join(directory, 'report.json'), null);
      if (job?.task !== task || job.status !== 'succeeded' || report?.passed !== true)
        throw new Error('独立評価に合格した同じ種類のモデルだけ有効化できます。');
      const artifact = path.join(directory, task === 'classification' ? 'model.joblib' : 'model.json');
      if (!(await stat(artifact)).isFile()) throw new Error('学習済みモデルが見つかりません。');
      await saveJson(path.join(this.directory, `active-${task}.json`), { id, activatedAt: new Date().toISOString() });
      return { task, active: id };
    });
  }
  async predict(task: MailTask, input: unknown) {
    if (!taskValid(task) || !input || typeof input !== 'object') throw new Error('予測要求が不正です。');
    const row = input as Record<string, unknown>;
    const subject = bounded(row.subject ?? '', 1000, '件名');
    const body = bounded(row.body ?? '', 19000, '本文');
    if (!subject && !body) throw new Error('件名または本文を指定してください。');
    const active = await readJson<{ id: string } | null>(path.join(this.directory, `active-${task}.json`), null);
    if (!active?.id || !/^[a-f0-9-]{36}$/.test(active.id)) throw new Error('有効モデルがありません。');
    const payload = { subject, body, ...(task === 'extraction' ? { kind: row.kind } : {}) };
    const output = await runPlannerEngine(['infer', '--task', task, '--directory', path.join(this.directory, 'runs', active.id)],
      JSON.stringify(payload), 45000, undefined, engine, python());
    return { ...JSON.parse(output), model_run_id: active.id, task };
  }
  async stop() { this.controller?.abort(); await this.running; }
}

/** 管理者が同一オリジンから操作し、確認済みデータだけを学習へ進めます。 */
export function registerMailTraining(app: FastifyInstance,
  authorize: (req: FastifyRequest, reply: FastifyReply) => boolean, service = new MailTrainingService()): MailTrainingService {
  const mutation = (action: (body: any) => Promise<unknown>) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authorize(req, reply)) return reply;
    if (req.headers['x-team-virtual-key'] || req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`)
      return reply.code(403).send({ error: { message: '同じサイトから操作してください。' } });
    try { return await action(req.body || {}); }
    catch (error) { return reply.code(400).send({ error: { message: error instanceof Error ? error.message : String(error) } }); }
  };
  app.get('/api/mail-training', async (req, reply) => authorize(req, reply) ? service.status() : reply);
  app.post('/api/mail-training/examples', mutation(body => service.importExamples(body.task, body.examples)));
  app.post('/api/mail-training/runs', mutation(body => service.start(body.task)));
  app.post('/api/mail-training/active', mutation(body => service.activate(body.task, body.id)));
  app.post('/api/mail-training/predict', mutation(body => service.predict(body.task, body)));
  app.post('/api/mail-training/stop', mutation(async () => { await service.stop(); return service.status(); }));
  app.addHook('onClose', () => service.stop());
  return service;
}
