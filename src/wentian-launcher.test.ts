import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

test('別の作業ディレクトリから起動してもCLIがインストール元の依存を解決する', async () => {
  // 一時Workspaceから本物のランチャーを起動し、作業先とインストール元を分離して検証します。
  const workspace = await mkdtemp(path.join(tmpdir(), 'wentian-launcher-workspace-'));
  try {
    const launcher = fileURLToPath(new URL('../bin/wentian.js', import.meta.url));
    const result = await execFileAsync(process.execPath, [launcher, '--help'], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    assert.match(result.stdout, /Wentian CLI/);
    assert.doesNotMatch(result.stderr, /Cannot find package ['"]docx['"]/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
