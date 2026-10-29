import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renameWithRetry } from './atomic-file.js';

test('一時Fileを同一DirectoryのTargetへAtomic Renameする', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-atomic-'));
  try {
    const source = path.join(root, 'value.tmp'); const target = path.join(root, 'value.json');
    await writeFile(source, '安全な内容'); await renameWithRetry(source, target);
    assert.equal(await readFile(target, 'utf8'), '安全な内容');
  } finally { await rm(root, { recursive: true, force: true }); }
});
