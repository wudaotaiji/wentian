import assert from 'node:assert/strict';
import test from 'node:test';
import { builtinWentianPlugins } from './wentian-plugin-runtime.js';

test('モデルからMemoryまで全Agent能力をPluginとして提供する', () => {
  const kinds = new Set(builtinWentianPlugins().map(plugin => plugin.kind));
  for (const kind of ['model', 'tool', 'skill', 'session', 'sandbox', 'storage', 'loop', 'scheduler', 'ui', 'planner', 'selector', 'runner', 'repair', 'verifier', 'memory']) {
    assert.ok(kinds.has(kind as never), `${kind} Pluginがありません。`);
  }
});
