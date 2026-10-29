import test from 'node:test';
import assert from 'node:assert/strict';
import { codexKnowledgeCompletion } from './codex-knowledge-completion.js';

const connection = { mode: 'native' as const, model: 'configured-model', status: 'verified' as const, checkedAt: '', expiresAt: '2999-01-01T00:00:00.000Z', fingerprint: '', policyHash: '' };

test('知識庫のCodex実行は登録・接続・対象外設定を確認する', async () => {
  let executions = 0;
  const execute = (async () => { executions++; return '{}'; }) as any;
  for (const options of [
    { connection: () => undefined, registered: () => true, permitted: () => true },
    { connection: () => ({ ...connection, status: 'pending' as const }), registered: () => true, permitted: () => true },
    { connection: () => ({ ...connection, expiresAt: '2000-01-01T00:00:00.000Z' }), registered: () => true, permitted: () => true },
    { connection: () => connection, registered: () => false, permitted: () => true },
    { connection: () => connection, registered: () => true, permitted: () => false },
  ]) {
    await assert.rejects(codexKnowledgeCompletion({ ...options, execute })([{ role: 'user', content: '確認' }], new AbortController().signal));
  }
  assert.equal(executions, 0);
});

test('CodexのCLI失敗本文をAPI例外へ漏らさない', async () => {
  const execute = (async () => { throw new Error('SECRET_MODEL_OUTPUT'); }) as any;
  await assert.rejects(
    codexKnowledgeCompletion({ connection: () => connection, registered: () => true, permitted: () => true, execute })([{ role: 'user', content: '確認' }], new AbortController().signal),
    (error: any) => error.code === 'model_response_failed' && !String(error.message).includes('SECRET_MODEL_OUTPUT'),
  );
});

test('知識庫の出典は標準入力で渡し、Codexを読み取り専用の隔離領域で実行する', async () => {
  const marker = '引用資料の固有文字列';
  let checked = false;
  const execute = (async (command: any, options: any) => {
    checked = true;
    assert.equal(command.args.at(-1), '-');
    assert.equal(command.args[command.args.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(command.args[command.args.indexOf('--model') + 1], connection.model);
    assert.ok(command.args.includes('--ephemeral'));
    assert.ok(options.cwd.includes('wentian-codex-knowledge-'));
    assert.ok(options.input.includes(marker));
    assert.ok(!command.args.join(' ').includes(marker));
    return '{"queries":["確認"]}';
  }) as any;
  const result = await codexKnowledgeCompletion({ connection: () => connection, registered: () => true, permitted: () => true, execute })([{ role: 'user', content: marker }], new AbortController().signal);
  assert.equal(result, '{"queries":["確認"]}');
  assert.ok(checked);
});
