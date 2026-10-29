import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { GroupResponder } from './agent-group.js';
import { renameWithRetry } from './atomic-file.js';
import type { WentianImageRuntime } from './wentian-image-runtime.js';

export interface VisualAsset { id: string; kind: 'background' | 'character'; name: string; url: string; prompt?: string; createdAt?: string; sprite?: number }
interface Settings { mode?: 'wentian' | 'custom'; endpoint: string; model: string; apiKey: string }
interface Session { id: string; status: 'idle' | 'thinking' | 'generating' | 'error'; messages: Array<{ role: string; content: string }>; assetId?: string; error?: string }
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max;
export const builtinVisualAssets: VisualAsset[] = [
  ...['office', 'mall', 'street', 'beach', 'classroom'].map((id, i) => ({ id, kind: 'background' as const, name: ['オフィス', 'ショッピングモール', '街角', '海辺', '教室'][i], url: '/assets/startup-forge/' + id + '.png' })),
  ...['紫髪のデザイナー', '眼鏡の開発者', '巻髪の企画担当', '銀髪の研究者', '創業者', '芸術家', '実験研究員', 'プロジェクト担当'].map((name, sprite) => ({ id: 'builtin-' + sprite, kind: 'character' as const, name, sprite, url: '/assets/startup-forge/characters.png' })),
  { id: 'medical-lab', kind: 'background', name: '研究室', url: '/assets/startup-forge/medical-lab.png' },
  { id: 'meeting-scribe', kind: 'character', name: '書記・議事録係', url: '/assets/startup-forge/meeting-scribe.png', prompt: '会議の書記・記録係。発言、決定事項、未解決点、担当者と期限を記録し議事録にまとめる。眼鏡と紺色ジャケット、クリップボードとペンを持つ全身の3Dカートゥーン人物。議長とは別の記録担当。' },
  ...[
    ['medical-professor', '医学教授'],
    ['medical-doctor', '医学博士'],
    ['medical-doctor-male', '医学博士'],
    ['medical-internist', '内科医'],
    ['medical-nurse', '护士'],
    ['medical-research-assistant', '研究助手'],
  ].map(([id, name]) => ({ id, kind: 'character' as const, name, url: '/assets/startup-forge/' + id + '.png' })),
];

/** 設定や制作会話を含めず、共有素材のメタデータだけ取得します。 */
export async function listVisualAssets(workspace: string): Promise<VisualAsset[]> {
  const root = path.join(workspace, '.wentian', 'visual-assets');
  let names: string[];
  try { names = await readdir(root); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [...builtinVisualAssets]; throw e; }
  const made = await Promise.all(names.filter(n => /^asset-[a-f0-9-]+\.json$/.test(n)).map(async n => JSON.parse(await readFile(path.join(root, n), 'utf8')) as VisualAsset));
  return [...builtinVisualAssets, ...made];
}

/** 自然言語の意味はAIへ委ね、ここでは出力の型とサイズだけを検証します。 */
export function parseVisualDecision(raw: string): { reply: string; asset: null | { kind: 'background' | 'character'; name: string; prompt: string } } {
  const d = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!text(d?.reply, 6000) || d.asset !== null && (!d.asset || !['background', 'character'].includes(d.asset.kind) || !text(d.asset.name, 100) || !text(d.asset.prompt, 6000))) throw new Error('AIの制作指示の形式を確認できませんでした。');
  return d;
}

/** OpenAI互換の画像生成プロトコル。接続先・モデル・認証は利用者が設定します。 */
export async function generateVisualImage(settings: Settings, prompt: string, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(settings.endpoint, { method: 'POST', redirect: 'error', signal, headers: { 'content-type': 'application/json', ...(settings.apiKey ? { authorization: 'Bearer ' + settings.apiKey } : {}) }, body: JSON.stringify({ model: settings.model, prompt, n: 1, response_format: 'b64_json' }) });
  if (!response.ok) throw new Error('画像生成サービスがエラーを返しました（HTTP ' + response.status + '）。接続設定を確認してください。');
  // 外部URLは取得せず、応答内のPNGだけ保存します。応答サイズも制限します。
  const reader = response.body?.getReader(); if (!reader) throw new Error('画像生成の応答がありません。');
  let size = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > 32 * 1024 ** 2) throw new Error('画像生成の応答が大きすぎます。'); chunks.push(r.value); } } finally { await reader.cancel(); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.data?.[0]?.b64_json;
  if (typeof data !== 'string') throw new Error('PNGのbase64応答に対応した画像生成サービスを指定してください。');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length < 24 || bytes.length > 20 * 1024 ** 2 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1) throw new Error('有効なPNG画像を取得できませんでした。');
  return bytes;
}

/** 群と独立した永続ライブラリ。管理者用の認証済みルート内へ登録します。 */
export function registerVisualAssets(app: FastifyInstance, workspace: string, respond?: GroupResponder, generate = generateVisualImage, runtime?: WentianImageRuntime) {
  const root = path.join(workspace, '.wentian', 'visual-assets'), busy = new Set<string>(), controllers = new Set<AbortController>(), jobs = new Set<Promise<void>>();
  async function save(name: string, value: unknown) { await mkdir(root, { recursive: true }); const target = path.join(root, name), tmp = target + '.' + randomUUID() + '.tmp'; await writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await renameWithRetry(tmp, target); }
  async function read<T>(name: string, fallback?: T): Promise<T> { try { return JSON.parse(await readFile(path.join(root, name), 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined) return fallback; throw e; } }
  async function settings() { return read<Settings>('settings.json', { mode: 'wentian', endpoint: process.env.WENTIAN_IMAGE_ENDPOINT || '', model: process.env.WENTIAN_IMAGE_MODEL || '', apiKey: process.env.WENTIAN_IMAGE_API_KEY || '' }); }
  const checkedId = (id: string) => { if (!idPattern.test(id)) throw new Error('制作IDが不正です。'); return id; };
  const list = async () => { let names: string[] = []; try { names = await readdir(root); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } const made = await Promise.all(names.filter(n => /^asset-[a-f0-9-]+\.json$/.test(n)).map(n => read<VisualAsset>(n))); return [...builtinVisualAssets, ...made.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))]; };
  app.get('/api/visual-assets', async () => ({ assets: await list() }));
  app.get('/api/visual-assets/settings', async () => {
    const s = await settings(), mode = s.mode || 'wentian';
    const inspection = mode === 'wentian' ? await runtime?.inspect() : undefined;
    return { mode, endpoint: s.endpoint, model: s.model, hasKey: !!s.apiKey, ready: mode === 'wentian' ? !!inspection?.candidates.length : !!s.endpoint && !!s.model, message: mode === 'wentian' ? inspection?.message || 'Wentianに任せるモードです。画像生成プラグインはまだ利用できません。制作相談は利用できます。' : '指定した接続先を使用します。' };
  });
  app.post('/api/visual-assets/settings', async req => {
    const b = req.body as Partial<Settings>; if (!b || b.mode !== undefined && !['wentian', 'custom'].includes(b.mode)) throw new Error('制作方法を選択してください。');
    const old = await settings(), mode = b.mode || 'wentian';
    if (mode === 'wentian') { await save('settings.json', { ...old, mode }); return { ok: true }; }
    if (!text(b.endpoint, 2000) || !text(b.model, 200) || b.apiKey !== undefined && (typeof b.apiKey !== 'string' || b.apiKey.length > 4000)) throw new Error('接続先URLとモデルを指定してください。');
    const url = new URL(b.endpoint); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('認証情報やクエリを含まないHTTP接続先を指定してください。');
    await save('settings.json', { mode, endpoint: url.href, model: b.model, apiKey: b.apiKey === undefined ? old.apiKey : b.apiKey }); return { ok: true };
  });
  app.get('/api/visual-assets/:id/content', async (req, reply) => { const id = checkedId((req.params as { id: string }).id); await read<VisualAsset>('asset-' + id + '.json'); return reply.type('image/png').header('cache-control', 'private, max-age=3600').header('x-content-type-options', 'nosniff').send(await readFile(path.join(root, id + '.png'))); });
  app.post('/api/visual-assets/sessions', async () => { const session: Session = { id: randomUUID(), status: 'idle', messages: [] }; await save('session-' + session.id + '.json', session); return session; });
  app.get('/api/visual-assets/sessions/:id', async req => { const id = checkedId((req.params as { id: string }).id), s = await read<Session>('session-' + id + '.json'); if (!busy.has(id) && ['thinking', 'generating'].includes(s.status)) { s.status = 'error'; s.error = 'サーバー停止により中断しました。続きの依頼を送信してください。'; await save('session-' + id + '.json', s); } return s; });
  app.post('/api/visual-assets/sessions/:id/messages', async (req, reply) => {
    const id = checkedId((req.params as { id: string }).id), b = req.body as { message: string; referenceId?: string };
    if (!text(b?.message, 4000)) throw new Error('制作したい内容を4000文字以内で入力してください。');
    if (!respond) throw new Error('会話用AIが未設定です。'); if (busy.has(id)) return reply.code(409).send({ error: { message: '制作中です。完了後に送信してください。' } });
    if (busy.size >= 2) return reply.code(409).send({ error: { message: '制作処理が混雑しています。少し待ってください。' } });
    busy.add(id);
    let s: Session; try { s = await read<Session>('session-' + id + '.json'); s.messages.push({ role: 'user', content: b.message }); s.status = 'thinking'; delete s.error; delete s.assetId; await save('session-' + id + '.json', s); } catch (e) { busy.delete(id); throw e; }
    const controller = new AbortController(); controllers.add(controller); const timeout = setTimeout(() => controller.abort(), 600000);
    const job = (async () => { try {
      const reference = b.referenceId ? (await list()).find(a => a.id === b.referenceId) : undefined;
      if (b.referenceId && !reference) throw new Error('参考素材がありません。');
      const result = await respond({ name: 'アートディレクター', role: '背景と人物の制作相談', model: 'wentian-agent/auto' }, [
        { role: 'system', content: '利用者とゲーム品質の背景・人物を制作する。意味と制作可否は会話から判断する。相談や確認ならasset:null。新しい画像を求めていて内容が足りればassetに制作指示を返す。形式は {"reply":"利用者と同じ言語の返答。生成済みと主張しない", "asset":null または {"kind":"background または character","name":"素材名","prompt":"完全な画像生成指示"}}。背景は人物なしの横長ゲーム背景、人物は単独全身・余白付き・透明背景を指示。プロ品質の統一感ある3Dカートゥーン。参考素材は名称と制作指示の文脈として利用し、画像そのものを見たとは主張しない。既存画像を上書きせず新規制作。参考素材: ' + JSON.stringify(reference || null) },
        ...s.messages.slice(-16).map(m => ({ ...m, content: m.content.slice(0, 4000) })),
      ], { groupId: 'visual-' + id, usedAgents: [], assetPlanning: true }, controller.signal);
      const decision = parseVisualDecision(typeof result === 'string' ? result : result.content);
      s.messages.push({ role: 'assistant', content: decision.reply });
      if (decision.asset) {
        const config = await settings(), mode = config.mode || 'wentian';
        if (mode === 'custom' && (!config.endpoint || !config.model)) throw new Error('任意指定の画像生成接続先とモデルが未設定です。');
        if (mode === 'wentian' && !runtime) throw new Error('Wentianの画像生成プラグインが利用できません。制作相談は利用できます。');
        s.status = 'generating'; await save('session-' + id + '.json', s);
        const bytes = mode === 'wentian' ? await runtime!.generate(decision.asset.prompt, controller.signal) : await generate(config, decision.asset.prompt, controller.signal), assetId = randomUUID();
        await writeFile(path.join(root, assetId + '.png'), bytes, { mode: 0o600 });
        await save('asset-' + assetId + '.json', { ...decision.asset, id: assetId, url: '/api/visual-assets/' + assetId + '/content', createdAt: new Date().toISOString() }); s.assetId = assetId;
        s.messages.push({ role: 'assistant', content: '画像を制作し、共通素材ライブラリへ保存しました。孵化器でも選択できます。' });
      } s.status = 'idle';
    } catch (e) { s.status = 'error'; s.error = e instanceof Error && !/fetch|network|JSON|Unexpected/i.test(e.message) ? e.message.slice(0, 500) : '制作に失敗しました。接続先とAIの応答形式を確認してください。'; }
    finally { clearTimeout(timeout); controllers.delete(controller); await save('session-' + id + '.json', s); busy.delete(id); } })();
    jobs.add(job); void job.catch(() => {}).finally(() => { jobs.delete(job); busy.delete(id); }); return reply.code(202).send(s);
  });
  app.addHook('onClose', async () => { for (const c of controllers) c.abort(); await Promise.allSettled(jobs); });
}
