import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentExclusionStorePath, agentNotExcluded, explicitAgentAllowed, isAgentExcluded, machineConfigDirectory, readAgentExclusions, readAgentExclusionsSync, setAgentExclusion, validateAgentExclusion } from './agent-exclusion-policy.js';

/**
 * 制御盤の【対象外】⇄【適用】設定（方針）の試験です。
 * 「どの外部エージェントを委任先から外すか」はこのPCの運用判断なので、
 * リポジトリ内の `.wentian/` ではなく本機設定目录へ保存されることを最初に固定します。
 */

/** 試験用に、進程専用の保存先へ読み替え（実設定へ書きません）。 */
async function isolated(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wentian-exclusion-test-'));
  process.env.WENTIAN_AGENT_EXCLUSIONS_FILE = path.join(directory, 'agent-exclusions.json');
  return directory;
}

test('対象外設定はGit管理下のリポジトリではなく、このPCの設定目录へ保存する', () => {
  // 試験環境が差し込んでいる上書きを外し、既定の決まり方そのものを検査します。
  const savedFile = process.env.WENTIAN_AGENT_EXCLUSIONS_FILE;
  const savedDir = process.env.WENTIAN_CONFIG_DIR;
  delete process.env.WENTIAN_AGENT_EXCLUSIONS_FILE;
  delete process.env.WENTIAN_CONFIG_DIR;
  try {
    const target = agentExclusionStorePath();
    // 作業リポジトリ（cwd）配下＝Git追従の場所に置かないことが要求の核心です。
    assert.ok(!target.startsWith(process.cwd() + path.sep), `保存先がリポジトリ配下です: ${target}`);
    assert.ok(!target.includes(`${path.sep}.wentian${path.sep}`), 'リポジトリ内の.wentian/へ置きません');
    assert.equal(path.basename(target), 'agent-exclusions.json');
    // 設定目录はOSのユーザー設定領域（Windowsは%LOCALAPPDATA%、他は~/.config）から決めます。
    assert.ok(machineConfigDirectory().startsWith(os.homedir()) || machineConfigDirectory().includes('wentian'));
  } finally {
    if (savedFile) process.env.WENTIAN_AGENT_EXCLUSIONS_FILE = savedFile; else delete process.env.WENTIAN_AGENT_EXCLUSIONS_FILE;
    if (savedDir) process.env.WENTIAN_CONFIG_DIR = savedDir; else delete process.env.WENTIAN_CONFIG_DIR;
  }
});

test('環境変数で保存先を差し替えられ、対象外⇄適用のラウンドトリップが復旧する', async () => {
  const directory = await isolated();
  try {
    const excluded = await setAgentExclusion('cline', true, 'admin', 'CLIがtool_callで止まる');
    assert.equal(excluded.id, 'cline'); assert.equal(excluded.excluded, true);
    assert.equal(excluded.actor, 'admin'); assert.equal(excluded.note, 'CLIがtool_callで止まる');
    assert.equal(isAgentExcluded('cline'), true);
    // 保存ファイルが実際に存在し、読み直せること（再起動をまたいで効くことの最低条件）を確認します。
    const stored = JSON.parse(await readFile(agentExclusionStorePath(), 'utf8'));
    assert.equal(stored.cline.excluded, true);
    assert.equal((await readAgentExclusions()).cline?.note, 'CLIがtool_callで止まる');
    assert.equal(readAgentExclusionsSync()['cline']?.excluded, true);
    // 【適用】＝解除は台帳から行そのものを消します（空の解除レコードを残しません）。
    await setAgentExclusion('cline', false, 'admin');
    assert.equal(isAgentExcluded('cline'), false);
    assert.deepEqual(await readAgentExclusions(), {});
  } finally { await rm(directory, { recursive: true, force: true }); delete process.env.WENTIAN_AGENT_EXCLUSIONS_FILE; }
});

test('ID検証と不正データの扱いを、実行を止めない方向へ固定する', async () => {
  const directory = await isolated();
  try {
    // 空白・パス脱出に使える文字・長不足は受け付けません（大文字は小文字へ正規化して accepts します）。
    for (const bad of ['a', 'cline tool', '../evil', 'clīne', 'x'.repeat(41)]) await assert.rejects(setAgentExclusion(bad, true), /2～40文字/);
    // 破損・不正IDの残骸は「対象外なし」と同じ扱いで読み進め、外部Agent実行を止めません。
    await writeFile(agentExclusionStorePath(), '{ this is not json', 'utf8');
    assert.deepEqual(readAgentExclusionsSync(), {});
    await writeFile(agentExclusionStorePath(), JSON.stringify({ 'BAD ID': { excluded: true }, crush: { excluded: false } }), 'utf8');
    assert.deepEqual(readAgentExclusionsSync(), {});
    // 配列・nullなどオブジェクトでない保存値も同じく「対象外なし」です。
    await writeFile(agentExclusionStorePath(), '[]', 'utf8');
    assert.deepEqual(readAgentExclusionsSync(), {});
    // 未作成ファイルも同じく「対象外なし」です（初回起動時に全Agentを除外しない）。
    await rm(agentExclusionStorePath(), { force: true });
    assert.deepEqual(readAgentExclusionsSync(), {});
    assert.equal(validateAgentExclusion({ id: ' Kilo ', excluded: true }).id, 'kilo');
  } finally { await rm(directory, { recursive: true, force: true }); delete process.env.WENTIAN_AGENT_EXCLUSIONS_FILE; }
});

test('判定ゲートは表示状態と保存値のどちらか一方でも対象外なら指定対象にしない', async () => {
  const directory = await isolated();
  try {
    assert.equal(agentNotExcluded(undefined), false, 'エージェント情報が無ければ候補にしません');
    assert.equal(agentNotExcluded({ id: 'kilo' }), true);
    // 保存値だけを対象外にしている場合（表示スナップショットが古い場合）も門を通過しません。
    await setAgentExclusion('kilo', true, 'admin');
    assert.equal(agentNotExcluded({ id: 'kilo' }), false);
    assert.equal(agentNotExcluded({ id: 'kilo', excluded: false }), false, '保存値を優先して対象外とします');
    // 表示スナップショットだけ対象外旗が立った場合（他の画面での操作など）も同様に止めます。
    assert.equal(agentNotExcluded({ id: 'crush', excluded: true }), false);
    assert.equal(agentNotExcluded({ id: 'crush' }), true);
    // グループ参加者の `external/<id>` のような明示指定も対象外を通過させません。
    assert.equal(explicitAgentAllowed('kilo'), false);
    assert.equal(explicitAgentAllowed('crush'), true);
    // 大文字混じりのID指定も同じ判定になります。
    assert.equal(isAgentExcluded('KILO'), true);
  } finally { await rm(directory, { recursive: true, force: true }); delete process.env.WENTIAN_AGENT_EXCLUSIONS_FILE; }
});

test('同一キーの再設定は新しい操作者に上書きし、辞書順で保存する', async () => {
  const directory = await isolated();
  try {
    await setAgentExclusion('opencode', true, 'admin-2');
    await setAgentExclusion('cline', true, 'admin-1');
    const rewritten = await setAgentExclusion('opencode', true, 'admin-3', '運用判断を変更');
    assert.equal(rewritten.actor, 'admin-3');
    const stored = await readAgentExclusions();
    assert.equal(stored.opencode?.actor, 'admin-3');
    assert.equal(stored.opencode?.note, '運用判断を変更');
    // 差分レビューし易いよう、キーは辞書順で書き出します。
    const keys = Object.keys(JSON.parse(await readFile(agentExclusionStorePath(), 'utf8')));
    assert.deepEqual(keys, [...keys].sort());
  } finally { await rm(directory, { recursive: true, force: true }); delete process.env.WENTIAN_AGENT_EXCLUSIONS_FILE; }
});
