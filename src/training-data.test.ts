import assert from 'node:assert/strict';
import test from 'node:test';
import { redactTrainingText } from './training-data.js';

test('学習データから秘密値と個人情報を伏字化する', () => {
  const redacted = redactTrainingText('Authorization: Bearer abc.def password=hunter2 api_key=sk-abcdefghijklmnop C:\\Users\\alice\\secret.txt alice@example.com');
  assert.doesNotMatch(redacted, /abc\.def|hunter2|sk-abcdefghijklmnop|alice@example\.com|Users\\alice/);
  assert.match(redacted, /REDACTED/);
  assert.match(redacted, /<USER_HOME>/);
});

test('学習用文字列を上限以内へ切り詰める', () => {
  assert.equal(redactTrainingText('a'.repeat(40_000)).length, 32_000);
});
