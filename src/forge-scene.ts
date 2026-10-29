import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { renameWithRetry } from './atomic-file.js';
import { builtinVisualAssets } from './visual-assets.js';

export interface ForgeScene {
  background: string;
  enabled: boolean;
  actors: Array<{ name: string; image: string; sprite?: number; x: number; y: number; fixed: boolean }>;
}
const builtinImages = new Set(builtinVisualAssets.map(asset => asset.url));
const imagePath = { test: (value: string) => builtinImages.has(value) || /^\/api\/visual-assets\/[a-f0-9-]{36}\/content$/.test(value) };
export function validateForgeScene(value: unknown): ForgeScene {
  const s = value as ForgeScene;
  const image = (v: unknown) => typeof v === 'string' && (imagePath.test(v) || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(v) && v.length <= 180000);
  if (!s || typeof s.background !== 'string' || !imagePath.test(s.background) || typeof s.enabled !== 'boolean' || !Array.isArray(s.actors) || s.actors.length > 24) throw new Error('舞台設定が不正です。');
  return { background: s.background, enabled: s.enabled, actors: s.actors.map(a => {
    if (!a || typeof a.name !== 'string' || !a.name.trim() || a.name.length > 100 || !image(a.image) || typeof a.fixed !== 'boolean' || !Number.isFinite(a.x) || a.x < 0 || a.x > 100 || !Number.isFinite(a.y) || a.y < 0 || a.y > 100 || a.sprite !== undefined && (!Number.isInteger(a.sprite) || a.sprite < 0 || a.sprite > 7)) throw new Error('人物の表示設定が不正です。');
    // 公開に必要な表示項目だけを保存し、ID・メール・IP・モデル・役割は受け取りません。
    return { name: a.name, image: a.image, x: a.x, y: a.y, fixed: a.fixed, ...(a.sprite !== undefined ? { sprite: a.sprite } : {}) };
  }) };
}
function file(workspace: string, id: string) {
  if (!/^group-[a-f0-9-]{36}$/.test(id)) throw new Error('グループIDが不正です。');
  return path.join(workspace, '.wentian', 'forge-scenes', id + '.json');
}
export async function loadForgeScene(workspace: string, id: string): Promise<ForgeScene | undefined> {
  try { return validateForgeScene(JSON.parse(await readFile(file(workspace, id), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function saveForgeScene(workspace: string, id: string, value: unknown) {
  const scene = validateForgeScene(value), target = file(workspace, id), temp = target + '.' + randomUUID() + '.tmp';
  await mkdir(path.dirname(target), { recursive: true });
  try { await writeFile(temp, JSON.stringify(scene), { mode: 0o600 }); await renameWithRetry(temp, target); }
  finally { await unlink(temp).catch(() => undefined); }
  return scene;
}
