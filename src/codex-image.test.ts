import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCodexImageAdapter } from './codex-image.js';

test('Codexの画像機能を確認し、隔離領域の実PNGだけ検収する', async () => {
  const dirs: string[] = [];
  const adapter = createCodexImageAdapter({ eligible: async () => true, run: async (command, options) => {
    if (command.args.includes('features')) return 'image_generation stable true';
    dirs.push(options.cwd); assert.equal(command.args.includes('workspace-write'), true); assert.equal(command.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
    const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(1024, 16); png.writeUInt32BE(768, 20); await writeFile(path.join(options.cwd, 'output.png'), png); return '画像を作成しました';
  } });
  try { assert.equal((await adapter.inspect())?.id, 'codex'); assert.equal((await adapter.generate('公園', new AbortController().signal)).readUInt32BE(16), 1024); } finally { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); }
});
test('未登録・除外済み・画像機能が無効なCodexを実行しない', async () => {
  let calls = 0; const denied = createCodexImageAdapter({ eligible: async () => false, run: async () => { calls++; return ''; } });
  assert.equal(await denied.inspect(), undefined); await assert.rejects(denied.generate('制作', new AbortController().signal)); assert.equal(calls, 0);
  const disabled = createCodexImageAdapter({ eligible: async () => true, run: async () => 'image_generation stable false' }); assert.equal(await disabled.inspect(), undefined);
});
test('Codexの成功報告だけで画像生成成功と扱わない', async () => {
  const dirs: string[] = []; const adapter = createCodexImageAdapter({ eligible: async () => true, run: async (command, options) => { if (command.args.includes('features')) return 'image_generation stable true'; dirs.push(options.cwd); await writeFile(path.join(options.cwd, 'output.png'), 'PNGではない'); return '制作成功'; } });
  try { await assert.rejects(adapter.generate('制作', new AbortController().signal), /完了しません/); } finally { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); }
});
test('参考画像の可変長引数と制作指示を区切り、制作指示の消失を防ぐ', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-image-args-')); const ref = path.join(root, 'ref.png'); await writeFile(ref, '参照試験'); const dirs: string[] = [];
  const adapter = createCodexImageAdapter({ eligible: async () => true, reference: ref, run: async (command, options) => { if (command.args.includes('features')) return 'image_generation stable true'; dirs.push(options.cwd); assert.equal(command.args.at(-2), '--'); assert.equal(command.args.at(-4), '--image'); assert.match(command.args.at(-1)!, /制作指示/); return '未完了'; } });
  try { await assert.rejects(adapter.generate('公園', new AbortController().signal)); } finally { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});
