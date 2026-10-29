import assert from 'node:assert/strict';
import test from 'node:test';
import { mailSolutionsHtml } from './mail-solutions.js';
import { withMailAppearance } from './mail-appearance-ui.js';

test('既存保存HTMLにも左メニューの縦スクロール設定を適用する', () => {
  // 古い保存内容を再現し、テンプレート側の設定だけで合格しないようにします。
  const savedHtml = mailSolutionsHtml.replace('overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;', '');
  const rendered = withMailAppearance(savedHtml);
  assert.match(rendered, /\.side\{overflow-y:scroll;overflow-x:hidden;overscroll-behavior:contain/);
  assert.match(rendered, /scrollbar-gutter:stable;height:100vh;height:100dvh/);
  assert.match(rendered, /\.side>\*\{flex-shrink:0\}/);
});
