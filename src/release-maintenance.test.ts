/**
 * Release Maintenance 専用テスト（Dedicated Test）。
 * 実ファイル（Real Files）だけを扱い、すべて os.tmpdir() 下の専用ディレクトリで実行する。
 * 本番アプリ・実リリースroot・ネットワーク・コマンド実行には一切触れない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  stageRelease, switchRelease, rollbackRelease, verifyRelease, readCurrentRelease, ReleaseError,
} from './release-maintenance.js';

test('検証関数が候補を変更しても、有効版への切替は拒否される', async () => {
  const { root, candidate } = await setup(); await put(candidate, 'app.js', '旧版');
  await stageRelease({ releaseRoot: root, versionId: 'v1', candidateRoot: candidate });
  await switchRelease({ releaseRoot: root, versionId: 'v1', runtimeStopped: true, validator: okValidator });
  await put(candidate, 'app.js', '新版'); await stageRelease({ releaseRoot: root, versionId: 'v2', candidateRoot: candidate });
  await expectCode('corrupt_release', () => switchRelease({ releaseRoot: root, versionId: 'v2', runtimeStopped: true, validator: async () => { await writeFile(path.join(root, 'versions', 'v2', 'files', 'app.js'), '検証中の改変'); return true; } }));
  assert.equal((await readCurrentRelease(root))!.activeVersionId, 'v1');
});

/** 毎回きれいな（専用リリースroot＋候補root）組を作る。 */
async function setup(): Promise<{ root: string; candidate: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), `wentian-release-test-${process.pid}-`));
  const root = path.join(base, 'release');
  const candidate = path.join(base, 'candidate');
  await mkdir(candidate, { recursive: true });
  return { root, candidate };
}

/** 候補ファイルを1つ置く（原本 / Source）。 */
async function put(candidate: string, name: string, content: string): Promise<void> {
  const target = path.join(candidate, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

/** code を指定して ReleaseError を期待する。 */
async function expectCode(code: string, action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof ReleaseError, `ReleaseError が欲しかった: ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

const okValidator = () => true;

test('成功系: ステージング→検証→切替で current.json が新版を指し、原本は不変', async () => {
  const { root, candidate } = await setup();
  await put(candidate, 'app.js', 'console.log(1);\n');
  await put(candidate, 'lib/util.js', 'export const v = 1;\n');
  const manifest = await stageRelease({ releaseRoot: root, versionId: 'v1', candidateRoot: candidate });
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.scope, 'managed-release-only');
  const sourceHash = await readFile(path.join(candidate, 'app.js'), 'utf8'); // 原本読み取り
  assert.equal(await readCurrentRelease(root), null);
  const pointer = await switchRelease({ releaseRoot: root, versionId: 'v1', runtimeStopped: true, validator: okValidator });
  assert.equal(pointer.activeVersionId, 'v1');
  assert.equal(pointer.previousVersionId, null);
  assert.equal((await readCurrentRelease(root))?.activeVersionId, 'v1');
  assert.equal(await readFile(path.join(candidate, 'app.js'), 'utf8'), sourceHash); // 原本不変
  assert.ok((await verifyRelease({ releaseRoot: root, versionId: 'v1' })).checked === 2);
});

test('更新失敗: validator 例外・false なら current.json と旧有効版が不変', async () => {
  const { root, candidate } = await setup();
  await put(candidate, 'app.js', 'v1\n');
  await stageRelease({ releaseRoot: root, versionId: 'v1', candidateRoot: candidate });
  await switchRelease({ releaseRoot: root, versionId: 'v1', runtimeStopped: true, validator: okValidator });
  await rm(candidate, { recursive: true, force: true });
  await put(candidate, 'app.js', 'v2-broken\n');
  await stageRelease({ releaseRoot: root, versionId: 'v2', candidateRoot: candidate });
  await expectCode('validation_failed', () =>
    switchRelease({ releaseRoot: root, versionId: 'v2', runtimeStopped: true, validator: () => false }));
  await expectCode('validation_failed', () =>
    switchRelease({ releaseRoot: root, versionId: 'v2', runtimeStopped: true, validator: async () => { throw new Error('検証NG'); } }));
  const current = await readCurrentRelease(root);
  assert.equal(current?.activeVersionId, 'v1'); // 旧有効版のまま
  assert.equal(current?.previousVersionId, null); // 失敗時はポインタ不変
});

test('任意コマンド拒否・runtimeStopped 省略拒否・破損拒否', async () => {
  const { root, candidate } = await setup();
  await put(candidate, 'app.js', 'v1\n');
  await stageRelease({ releaseRoot: root, versionId: 'v1', candidateRoot: candidate });
  // コマンド文字列を validator として渡すと拒否（child_process は本モジュールに存在しない）
  await expectCode('command_refused', () =>
    switchRelease({ releaseRoot: root, versionId: 'v1', runtimeStopped: true, validator: 'npm run smoke' }));
  // 稼働中（フラグなし）の切替拒否
  await expectCode('runtime_flag_required', () =>
    switchRelease({ releaseRoot: root, versionId: 'v1', validator: okValidator }));
  assert.equal(await readCurrentRelease(root), null);
  await switchRelease({ releaseRoot: root, versionId: 'v1', runtimeStopped: true, validator: okValidator });
  // ステージ済み実体の破損（Tamper）は切替を拒否し、ポインタは不変
  await put(candidate, 'app.js', 'v2\n');
  await stageRelease({ releaseRoot: root, versionId: 'v2', candidateRoot: candidate });
  await writeFile(path.join(root, 'versions', 'v2', 'files', 'app.js'), 'tampered\n');
  await expectCode('corrupt_release', () =>
    switchRelease({ releaseRoot: root, versionId: 'v2', runtimeStopped: true, validator: okValidator }));
  assert.equal((await readCurrentRelease(root))?.activeVersionId, 'v1');
});

test('rollback: 成功後でもとの有効版へ戻せる／戻し先破損時は拒否し現ポインタ不変', async () => {
  const { root, candidate } = await setup();
  await put(candidate, 'app.js', 'v1\n');
  await stageRelease({ releaseRoot: root, versionId: 'v1', candidateRoot: candidate });
  await switchRelease({ releaseRoot: root, versionId: 'v1', runtimeStopped: true, validator: okValidator });
  await rm(candidate, { recursive: true, force: true });
  await put(candidate, 'app.js', 'v2\n');
  await stageRelease({ releaseRoot: root, versionId: 'v2', candidateRoot: candidate });
  await switchRelease({ releaseRoot: root, versionId: 'v2', runtimeStopped: true, validator: okValidator });
  assert.equal((await readCurrentRelease(root))?.previousVersionId, 'v1');
  // 旧有効版の manifest 検証付き rollback
  const back = await rollbackRelease({ releaseRoot: root, runtimeStopped: true });
  assert.equal(back.activeVersionId, 'v1');
  assert.equal(back.previousVersionId, null); // 二重巻き戻し防止
  // 戻し先（previous）が破損している場合は拒否し、現ポインタ（v2 有効）は不変
  await switchRelease({ releaseRoot: root, versionId: 'v2', runtimeStopped: true, validator: okValidator }); // rollback 後は previous=null のため v2 へは切替で戻る
  await writeFile(path.join(root, 'versions', 'v1', 'files', 'app.js'), 'rotten\n');
  await expectCode('corrupt_release', () => rollbackRelease({ releaseRoot: root, runtimeStopped: true }));
  assert.equal((await readCurrentRelease(root))?.activeVersionId, 'v2');
});

test('範囲外（Out of Scope）拒否: root重なり・版ID ../・未ステージング版', async () => {
  const { root, candidate } = await setup();
  await put(candidate, 'app.js', 'v1\n');
  // 候補root＝リリースroot の重なりは原本破壊につながるため拒否
  await expectCode('root_overlap', () => stageRelease({ releaseRoot: root, versionId: 'v1', candidateRoot: root }));
  await expectCode('root_overlap', () => stageRelease({ releaseRoot: root, versionId: 'v1', candidateRoot: path.join(root, 'inside') }));
  // 版IDへの `..`・絶対パス指定は構造的に拒否
  await expectCode('unsafe_version_id', () => stageRelease({ releaseRoot: root, versionId: '../evil', candidateRoot: candidate }));
  await expectCode('unsafe_version_id', () => verifyRelease({ releaseRoot: root, versionId: 'C:\\Windows' }));
  // 未ステージング版の切替・rollback 拒否
  await expectCode('unknown_version', () => switchRelease({ releaseRoot: root, versionId: 'v9', runtimeStopped: true, validator: okValidator }));
  await expectCode('no_previous_version', () => rollbackRelease({ releaseRoot: root, runtimeStopped: true }));
});

test('秘密らしいファイル拒否: .env 等の候補はステージング段階で弾く', async () => {
  const { root, candidate } = await setup();
  await put(candidate, 'app.js', 'v1\n');
  await put(candidate, '.env', 'SECRET=hunter2\n');
  await expectCode('credential_excluded', () => stageRelease({ releaseRoot: root, versionId: 'v1', candidateRoot: candidate }));
  await rm(path.join(candidate, '.env'));
  await expectCode('credential_excluded', async () => { await put(candidate, 'sub/id_rsa', 'key\n'); return stageRelease({ releaseRoot: root, versionId: 'v1b', candidateRoot: candidate }); });
});

test('リンク拒否: 版内のハードリンク（nlink>1）を SHA256 一致でも拒否（作れなければ skip）', async (t) => {
  const { root, candidate } = await setup();
  await put(candidate, 'app.js', 'v1\n');
  await put(candidate, 'other.js', 'other\n');
  await stageRelease({ releaseRoot: root, versionId: 'v1', candidateRoot: candidate });
  const filesDir = path.join(root, 'versions', 'v1', 'files');
  // 台帳通りの中身のままハードリンク化すると SHA256 は通るが、nlink>1 単独で拒否されなければならない
  await rm(path.join(filesDir, 'app.js'));
  try { await link(path.join(candidate, 'app.js'), path.join(filesDir, 'app.js')); }
  catch { await t.skip('この環境ではハードリンクを作れない'); return; }
  assert.equal((await readFile(path.join(filesDir, 'app.js'), 'utf8')), 'v1\n'); // 中身（SHA256）は台帳と一致した状態
  await expectCode('link_refused', () => verifyRelease({ releaseRoot: root, versionId: 'v1' }));
  await expectCode('link_refused', () => switchRelease({ releaseRoot: root, versionId: 'v1', runtimeStopped: true, validator: okValidator }));
});

test('リンク拒否: 候補・祖先のシンボリックリンク／ジャンクションを拒否（作れなければ skip）', async (t) => {
  const { root, candidate } = await setup();
  await put(candidate, 'app.js', 'v1\n');
  const outside = path.join(path.dirname(candidate), 'outside-target.txt');
  await writeFile(outside, 'evil\n');
  try { await symlink(outside, path.join(candidate, 'escape.js'), 'file'); }
  catch {
    // Windowsでファイルリンクの権限がなくても、ジャンクション（Junction）の祖先拒否は実検査する。
    const linkPath = path.join(path.dirname(root), 'linked-release');
    await mkdir(root, { recursive: true });
    await symlink(root, linkPath, 'junction');
    await expectCode('link_refused', () => stageRelease({ releaseRoot: linkPath, versionId: 'v2', candidateRoot: candidate }));
    return;
  }
  await expectCode('link_refused', () => stageRelease({ releaseRoot: root, versionId: 'v1', candidateRoot: candidate }));
  await rm(path.join(candidate, 'escape.js'));
  await stageRelease({ releaseRoot: root, versionId: 'v1', candidateRoot: candidate }); // クリーンな候補なら成功する
  // リリースroot自身の祖先にリンク（ジャンクション）がある場合はステージングを拒否
  const linkPath = path.join(path.dirname(root), 'linked-release');
  try { await symlink(root, linkPath, 'junction'); }
  catch { await t.skip('この環境ではジャンクションを作れない'); return; }
  await expectCode('link_refused', () => stageRelease({ releaseRoot: linkPath, versionId: 'v2', candidateRoot: candidate }));
  await expectCode('link_refused', () => verifyRelease({ releaseRoot: linkPath, versionId: 'v1' }));
});
