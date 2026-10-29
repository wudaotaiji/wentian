/**
 * 限定外部タスク（Confined External Task / 限定外部タスク）試験
 *
 * 重要: ここでは runExternalCommand をMockして「Claudeの応答テキスト」だけを再現する。
 * 実LLM・実CLIは一切起動しない（外部CLI実行はCodexが行う運用原則に従う）。
 * 原本は mkdtemp（一時目録）だけを使い、テスト内のgit操作も一時リポジトリのみ。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { runExternalCommand } from './external-orchestrator.js';
import { runConfinedExternalTask, buildConfinedClaudeCommand, buildConfinedPlan, CONFINED_LIMITS, type ConfinedExternalTaskResult } from './confined-external-task.js';

/** 記録付きCLI Mock。起動回数・受け取ったコマンド・cwdを記録し、応答テキストは固定で返す。 */
function mockRunCommand(output: string | ((call: number) => string)) {
  const calls: Array<{ executable: string; args: string[]; cwd: string }> = [];
  const runCommand = async (command: { executable: string; args: string[] }, options: { cwd: string }) => {
    calls.push({ executable: command.executable, args: command.args, cwd: options.cwd });
    return typeof output === 'function' ? output(calls.length) : output;
  };
  return { calls, runCommand: runCommand as unknown as typeof runExternalCommand };
}

/** 一時原本（Git管理外でも動作する）に target/a.txt と input/spec.txt を置く。 */
async function makeSource(): Promise<string> {
  const source = await mkdtemp(path.join(tmpdir(), `wentian-confined-${process.pid}-`));
  await mkdir(path.join(source, 'target'), { recursive: true });
  await mkdir(path.join(source, 'input'), { recursive: true });
  await writeFile(path.join(source, 'target', 'a.txt'), '古い内容\n');
  await writeFile(path.join(source, 'input', 'spec.txt'), '仕様: 合格印は ACCEPTED の1語。\n');
  return source;
}

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');
const proposal = (changes: unknown[]) => JSON.stringify({ changes });

test('正常系: 提案JSONをホストが検証・適用し、ホスト固定受入の合格で原本へ反映する', async () => {
  const source = await makeSource();
  try {
    const { calls, runCommand } = mockRunCommand(proposal([{ path: 'target/a.txt', content: 'ACCEPTED\n' }]));
    const plan = buildConfinedPlan('target/a.txt を ACCEPTED に更新してください。', ['target/a.txt']);
    plan.attachments = [{ type: 'local_file', path: 'input/spec.txt' }];
    const result = await runConfinedExternalTask(plan, source, {
      model: 'managed/claude-test', acceptanceChecks: [{ path: 'target/a.txt', contains: 'ACCEPTED' }],
    }, { runCommand });
    assert.equal(result.outcome.status, 'success');
    assert.equal(result.cliLaunchCount, 1);
    // shell=false の固定起動: --tools へ空文字が独立引数として渡り、Tool・MCP・Hookが無効化されている。
    const args = calls[0].args;
    assert.ok(args.includes('--tools') && args[args.indexOf('--tools') + 1] === '');
    for (const flag of ['--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(args[args.indexOf('--model') + 1], 'managed/claude-test');
    assert.ok(!args.includes('--permission-prompts'), '未対応旗は渡さない');
    // プロンプトへ許可入力の実内容と許可リストが入る（ホストが入力を読み添付）。
    assert.match(args[1], /ACCEPTED の1語/);
    assert.match(args[1], /target\/a\.txt/);
    // 変更前ハッシュは反映前の原本内容、変更後ハッシュは新内容と一致し、原本が更新されている。
    assert.deepEqual(result.changes, [{ path: 'target/a.txt', bytes: 9, beforeHash: hashOf('古い内容\n'), afterHash: hashOf('ACCEPTED\n') }]);
    assert.equal(await readFile(path.join(source, 'target', 'a.txt'), 'utf8'), 'ACCEPTED\n');
    assert.ok(result.outcome.manifestPath);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('権限違反: 許可範囲外パスの提案は失敗とし、原本も隔離場所も変更しない', async () => {
  const source = await makeSource();
  try {
    const { runCommand } = mockRunCommand(proposal([{ path: 'target/a.txt', content: 'ACCEPTED\n' }, { path: 'input/spec.txt', content: '乗っ取り\n' }]));
    const plan = buildConfinedPlan('更新。', ['target/a.txt']);
    const result = await runConfinedExternalTask(plan, source, { model: 'm/x', acceptanceChecks: [{ path: 'target/a.txt', contains: 'ACCEPTED' }] }, { runCommand });
    assert.equal(result.outcome.status, 'failed');
    assert.match(result.outcome.reason || '', /許可範囲外/);
    assert.equal(await readFile(path.join(source, 'input', 'spec.txt'), 'utf8'), '仕様: 合格印は ACCEPTED の1語。\n');
    assert.equal(await readFile(path.join(source, 'target', 'a.txt'), 'utf8'), '古い内容\n');
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('JSON不正: 変更提案JSONでない応答は失敗（部分適用しない）', async () => {
  const source = await makeSource();
  try {
    const { runCommand } = mockRunCommand('{' + '"changes": [/path: 壊れたJSON');
    const plan = buildConfinedPlan('更新。', ['target/a.txt']);
    const result = await runConfinedExternalTask(plan, source, { model: 'm/x', acceptanceChecks: [{ path: 'target/a.txt', contains: 'ACCEPTED' }] }, { runCommand });
    assert.equal(result.outcome.status, 'failed');
    assert.match(result.outcome.reason || '', /JSON/);
    assert.equal(await readFile(path.join(source, 'target', 'a.txt'), 'utf8'), '古い内容\n');
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('偽成功: 「成功しました」だけの自己申告テキストは失敗', async () => {
  const source = await makeSource();
  try {
    const { runCommand } = mockRunCommand('作業に成功しました。ファイルを全部更新しました。');
    const plan = buildConfinedPlan('更新。', ['target/a.txt']);
    const result = await runConfinedExternalTask(plan, source, { model: 'm/x', acceptanceChecks: [{ path: 'target/a.txt', contains: 'ACCEPTED' }] }, { runCommand });
    assert.equal(result.outcome.status, 'failed');
    assert.equal(await readFile(path.join(source, 'target', 'a.txt'), 'utf8'), '古い内容\n');
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('偽成功: changes が空配列の応答も失敗（空反映を成功にしない）', async () => {
  const source = await makeSource();
  try {
    const { runCommand } = mockRunCommand(proposal([]));
    const plan = buildConfinedPlan('更新。', ['target/a.txt']);
    const result = await runConfinedExternalTask(plan, source, { model: 'm/x', acceptanceChecks: [{ path: 'target/a.txt', contains: 'ACCEPTED' }] }, { runCommand });
    assert.equal(result.outcome.status, 'failed');
    assert.match(result.outcome.reason || '', /0件/);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('run_command無視: 提案へ実行要求キーがあれば記録して無視し、CLI起動は1回のまま', async () => {
  const source = await makeSource();
  try {
    const { calls, runCommand } = mockRunCommand(proposal([{ path: 'target/a.txt', content: 'ACCEPTED\n', run_command: 'rm -rf /' }]));
    const plan = buildConfinedPlan('更新。', ['target/a.txt']);
    const result = await runConfinedExternalTask(plan, source, { model: 'm/x', acceptanceChecks: [{ path: 'target/a.txt', contains: 'ACCEPTED' }] }, { runCommand });
    assert.equal(result.outcome.status, 'success');
    assert.deepEqual(result.ignoredProposalFields, ['run_command']);
    assert.equal(result.cliLaunchCount, 1);
    assert.equal(calls.length, 1);
    // run_command は実行されず、変更は write_file 経由の1ファイルだけ。
    assert.equal(await readFile(path.join(source, 'target', 'a.txt'), 'utf8'), 'ACCEPTED\n');
    assert.equal(await readFile(path.join(source, 'input', 'spec.txt'), 'utf8').then(() => 'intact'), 'intact');
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('検証失敗: ホスト受入検査（contains）不合格では原本へ反映しない', async () => {
  const source = await makeSource();
  try {
    const { runCommand } = mockRunCommand(proposal([{ path: 'target/a.txt', content: 'ACCEPTEDじゃない内容\n' }]));
    const plan = buildConfinedPlan('更新。', ['target/a.txt']);
    const result = await runConfinedExternalTask(plan, source, { model: 'm/x', acceptanceChecks: [{ path: 'target/a.txt', contains: 'ACCEPTED_ONLY' }] }, { runCommand });
    assert.equal(result.outcome.status, 'failed');
    assert.equal(await readFile(path.join(source, 'target', 'a.txt'), 'utf8'), '古い内容\n');
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('受入条件未設定: CLIを起動せず needs_review（反映もしない）', async () => {
  const source = await makeSource();
  try {
    const { calls, runCommand } = mockRunCommand(proposal([{ path: 'target/a.txt', content: 'x\n' }]));
    const plan = buildConfinedPlan('更新。', ['target/a.txt']);
    const result = await runConfinedExternalTask(plan, source, { model: 'm/x' }, { runCommand });
    assert.equal(result.outcome.status, 'needs_review');
    assert.equal(result.cliLaunchCount, 0);
    assert.equal(calls.length, 0);
    assert.match(result.outcome.reason || '', /受入条件/);
    assert.equal(await readFile(path.join(source, 'target', 'a.txt'), 'utf8'), '古い内容\n');
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('重複パス拒否: 同一パス（大文字小文字違い含む）の重複提案は失敗', async () => {
  const source = await makeSource();
  try {
    const { runCommand } = mockRunCommand(proposal([{ path: 'target/a.txt', content: 'one\n' }, { path: 'TARGET/A.TXT', content: 'two\n' }]));
    const plan = buildConfinedPlan('更新。', ['target/a.txt']);
    const result = await runConfinedExternalTask(plan, source, { model: 'm/x', acceptanceChecks: [{ path: 'target/a.txt', contains: 'one' }] }, { runCommand });
    assert.equal(result.outcome.status, 'failed');
    assert.match(result.outcome.reason || '', /重複/);
    assert.equal(await readFile(path.join(source, 'target', 'a.txt'), 'utf8'), '古い内容\n');
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('モデル未設定は起動前に拒否（CLIを起動しない）', async () => {
  const source = await makeSource();
  try {
    const { calls, runCommand } = mockRunCommand('{}');
    const plan = buildConfinedPlan('更新。', ['target/a.txt']);
    await assert.rejects(runConfinedExternalTask(plan, source, { model: '  ', acceptanceChecks: [{ path: 'target/a.txt', contains: 'x' }] }, { runCommand }), /モデル/);
    assert.equal(calls.length, 0);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('秘密入力の拒否: .env・認証台帳相当の添付はCLI起動前に拒否', async () => {
  const source = await makeSource();
  try {
    const { calls, runCommand } = mockRunCommand('{}');
    for (const bad of ['.env', 'config/認証台帳.txt', 'secrets/id_rsa', 'k8s/service-account.json.key']) {
      const plan = buildConfinedPlan('参照して更新。', ['target/a.txt']);
      plan.attachments = [{ type: 'local_file', path: bad }];
      await assert.rejects(runConfinedExternalTask(plan, source, { model: 'm/x', acceptanceChecks: [{ path: 'target/a.txt', contains: 'x' }] }, { runCommand }), /秘密|管理用/, bad);
    }
    assert.equal(calls.length, 0);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('入力上限: 1ファイルが上限超過ならCLIを起動せず失敗', async () => {
  const source = await makeSource();
  try {
    await writeFile(path.join(source, 'input', 'big.txt'), 'あ'.repeat(CONFINED_LIMITS.maxInputFileBytes));
    const { calls, runCommand } = mockRunCommand('{}');
    const plan = buildConfinedPlan('参照して更新。', ['target/a.txt']);
    plan.attachments = [{ type: 'local_file', path: 'input/big.txt' }];
    const result = await runConfinedExternalTask(plan, source, { model: 'm/x', acceptanceChecks: [{ path: 'target/a.txt', contains: 'x' }] }, { runCommand });
    assert.equal(result.outcome.status, 'failed');
    assert.equal(result.cliLaunchCount, 0);
    assert.equal(calls.length, 0);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('原本競合: 制作中に原本が別更新されたら反映せず needs_review（人間の変更を守る）', async () => {
  const source = await makeSource();
  try {
    // CLI応答待ちの間（Mock呼び出し内）に原本だけを更新し、制作中の原本変更を再現する。
    const calls: Array<{ executable: string; args: string[] }> = [];
    const racing = (async (command: { executable: string; args: string[] }) => {
      calls.push({ executable: command.executable, args: command.args });
      await writeFile(path.join(source, 'target', 'a.txt'), '人間の別変更\n');
      return proposal([{ path: 'target/a.txt', content: 'ACCEPTED\n' }]);
    }) as unknown as typeof runExternalCommand;
    const plan = buildConfinedPlan('更新。', ['target/a.txt']);
    const result = await runConfinedExternalTask(plan, source, { model: 'm/x', acceptanceChecks: [{ path: 'target/a.txt', contains: 'ACCEPTED' }] }, { runCommand: racing });
    assert.equal(result.outcome.status, 'needs_review');
    assert.equal(calls.length, 1);
    // publishTaskWorkspace の beforeHash 競合検出で反映が見送られ、人間の更新が残る。
    assert.equal(await readFile(path.join(source, 'target', 'a.txt'), 'utf8'), '人間の別変更\n');
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('起動コマンドの固定: 管理済みモデルIDのみ受理し、未対応旗・自由引数は作れない', () => {
  const command = buildConfinedClaudeCommand({ model: 'managed/claude-test', prompt: 'test' });
  assert.ok(command.executable);
  assert.ok(command.args.includes('--max-turns') && command.args[command.args.indexOf('--max-turns') + 1] === '1');
  assert.ok(command.args.includes('--settings') && command.args[command.args.indexOf('--settings') + 1].includes('disableAllHooks'));
  assert.ok(command.args.includes('--mcp-config') && command.args[command.args.indexOf('--mcp-config') + 1] === '{"mcpServers":{}}');
  // 空白・引用・制御文字を含む「モデル風文字列」は起動前に拒否（コマンド行注入面の排除）。
  assert.throws(() => buildConfinedClaudeCommand({ model: 'm" --danger', prompt: 'x' }), /モデル/);
  assert.throws(() => buildConfinedClaudeCommand({ model: '', prompt: 'x' }), /モデル/);
});

test('結果・応答に依頼生データを含めない: 返値はパス・サイズ・ハッシュ・状態のみ', async () => {
  const source = await makeSource();
  try {
    const secretRequest = 'この依頼文だけは秘密の依頼文です';
    const { runCommand } = mockRunCommand(proposal([{ path: 'target/a.txt', content: 'ACCEPTED\n' }]));
    const plan = buildConfinedPlan(secretRequest, ['target/a.txt']);
    const result: ConfinedExternalTaskResult = await runConfinedExternalTask(plan, source, { model: 'm/x', acceptanceChecks: [{ path: 'target/a.txt', contains: 'ACCEPTED' }] }, { runCommand });
    assert.equal(result.outcome.status, 'success');
    const serialized = JSON.stringify({ outcome: result.outcome, changes: result.changes, ignored: result.ignoredProposalFields });
    assert.ok(!serialized.includes(secretRequest), '返値JSONに依頼文が生データとして現れない');
    assert.ok(!serialized.includes('ACCEPTED\n'), '返値JSONにファイル内容を生データとして現れない');
  } finally { await rm(source, { recursive: true, force: true }); }
});
