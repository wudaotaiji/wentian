import assert from 'node:assert/strict';
import test from 'node:test';
import { responseLanguage, safeRuntimeContext } from './agent-context.js';

test('分類LLMが言語を返さない内部処理では設定した表示言語を使う', () => {
  const old = process.env.WENTIAN_RESPONSE_LANGUAGE;
  try {
    for (const language of ['zh', 'ja', 'en'] as const) {
      process.env.WENTIAN_RESPONSE_LANGUAGE = language;
      assert.equal(responseLanguage('混在した任意の原文'), language);
    }
  } finally { if (old === undefined) delete process.env.WENTIAN_RESPONSE_LANGUAGE; else process.env.WENTIAN_RESPONSE_LANGUAGE = old; }
});

test('実行環境の事実はLLMに渡し、質問を定型文の回答へ短絡しない', () => {
  assert.match(safeRuntimeContext('C:\\work'), /current_directory=C:\\work/);
});
