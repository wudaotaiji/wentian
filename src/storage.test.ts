import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlEventStore } from './storage.js';

test('秘密情報を除外し、保持件数を制限する', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wentian-storage-'));
  try {
    const path = join(directory, 'events.jsonl');
    const store = new JsonlEventStore({ path, maxRecords: 2 });
    await store.append({ kind: 'routing', provider: 'p1', detail: { prompt: '保存禁止', reason: 'ok', apiKey: '保存禁止' } });
    await store.append({ kind: 'metric', provider: 'p1', latencyMs: 10 });
    await store.append({ kind: 'circuit', provider: 'p1', state: 'closed' });
    const items = await store.list({ limit: 10 });
    assert.equal(items.length, 2);
    assert.equal((await readFile(path, 'utf8')).includes('保存禁止'), false);
  } finally {
    // テスト専用一時フォルダーだけを削除する。
    await rm(directory, { recursive: true, force: true });
  }
});

test('壊れた行を無視して正常なイベントを返す', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wentian-storage-'));
  try {
    const path = join(directory, 'events.jsonl');
    const store = new JsonlEventStore({ path });
    await store.append({ kind: 'audit', action: 'test' });
    assert.equal((await store.list({ kind: 'audit' })).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
