import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, link, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { executeAgentTool } from './agent-tools.js';

/** 攻撃入力を実際にツール境界へ渡し、拒否と原本不変を検証します。 */
test('限定書込みは親・許可外・子プロセス経由・保護ファイルを拒否する', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'wentian-confinement-'));
  await writeFile(path.join(workspace, 'protected.txt'), '保持');
  const call = (name: string, input: unknown) => ({ id: 'attack', type: 'function' as const, function: { name, arguments: JSON.stringify(input) } });
  const policy = { allowedWritePaths: ['allowed.txt'], protectedFiles: ['protected.txt'] };
  for (const target of ['../outside.txt', 'other.txt', 'protected.txt', '.git/config']) {
    await assert.rejects(executeAgentTool(call('write_file', { path: target, content: '侵入' }), workspace, undefined, policy));
  }
  await assert.rejects(executeAgentTool(call('run_command', { command: 'node -e "require(\'fs\').writeFileSync(\'other.txt\',\'侵入\')"' }), workspace, undefined, policy), /任意コマンド/);
  assert.equal(await readFile(path.join(workspace, 'protected.txt'), 'utf8'), '保持');
  await executeAgentTool(call('write_file', { path: 'allowed.txt', content: '許可された成果' }), workspace, undefined, policy);
  assert.equal(await readFile(path.join(workspace, 'allowed.txt'), 'utf8'), '許可された成果');
});

test('シンボリックリンクとハードリンクで許可ファイルをすり替えても原本は不変', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-linked-'));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const outside = path.join(root, 'outside.txt'); await writeFile(outside, '原本');
  await link(outside, path.join(workspace, 'hard.txt'));
  await symlink(root, path.join(workspace, 'parent'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const target of ['hard.txt', 'parent/outside.txt']) {
    for (const name of ['read_file', 'write_file']) {
      await assert.rejects(executeAgentTool({ id: 'attack', type: 'function', function: { name, arguments: JSON.stringify({ path: target, content: '侵入' }) } }, workspace, undefined, { allowedWritePaths: [target] }), /リンク/);
    }
  }
  assert.equal(await readFile(outside, 'utf8'), '原本');
});
