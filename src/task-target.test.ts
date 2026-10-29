import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTaskTarget } from './task-target.js';

test('中国語の下面表現からWindows作業先だけを抽出する', () => {
  assert.deepEqual(resolveTaskTarget('在C:\\mywork\\temp下面做一个第一视角的射击游戏', 'C:\\repo', 'C:\\mywork\\temp'), { workspace: 'C:\\mywork\\temp', explicit: true, source: 'unquoted_path' });
});

test('Plannerが依頼文にない作業先を指定しても採用しない', () => {
  assert.throws(() => resolveTaskTarget('ここに作成', 'C:\\repo', 'C:\\elsewhere'), /明示されていません/);
});
test('空白を含む引用Pathを優先する', () => {
  assert.equal(resolveTaskTarget('"C:\\my work\\game" に作成', 'C:\\repo').workspace, 'C:\\my work\\game');
});

test('明示Pathがなければ起動Workspaceを使う', () => {
  assert.equal(resolveTaskTarget('ここに作成', 'C:\\repo').explicit, false);
});
