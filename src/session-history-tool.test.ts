import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listSessionHistory } from './session-history-tool.js';

test('Session履歴ツールは日付で絞り、記録の範囲と依頼・応答を返す', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-history-'));
  const beforePath = process.env.WENTIAN_SESSION_PATH;
  const beforeZone = process.env.WENTIAN_TIMEZONE;
  process.env.WENTIAN_SESSION_PATH = root;
  process.env.WENTIAN_TIMEZONE = 'Asia/Tokyo';
  try {
    const session = { version: '1.0', id: 'wt-20261013-000000-12345678', createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T01:00:00.000Z', workspace: root, model: 'test', messages: [{ role: 'user', content: '資料を確認して' }, { role: 'assistant', content: '確認しました。' }] };
    await writeFile(path.join(root, `${session.id}.json`), JSON.stringify(session));
    const result = JSON.parse(await listSessionHistory({ date: '2026-10-13', limit: 1 }));
    assert.equal(result.totalMatched, 1);
    assert.equal(result.sessions[0].messages[0].content, '資料を確認して');
    assert.match(result.coverage, /実作業の完了状態は記録されていません/);
    await assert.rejects(() => listSessionHistory({ date: '../secret' }));
  } finally {
    if (beforePath === undefined) delete process.env.WENTIAN_SESSION_PATH; else process.env.WENTIAN_SESSION_PATH = beforePath;
    if (beforeZone === undefined) delete process.env.WENTIAN_TIMEZONE; else process.env.WENTIAN_TIMEZONE = beforeZone;
    await rm(root, { recursive: true, force: true });
  }
});
