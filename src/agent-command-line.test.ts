import assert from 'node:assert/strict';
import test from 'node:test';
import { commandLine, failedCommandOf, redactCommandSecrets } from './agent-command-line.js';

// 制御盤の補足列に載す「失敗した起動コマンド行」は、作業者が端末へそのまま貼り付けて
// 再実行できることが目的です。同時に、秘密情報を画面・証跡・保存ファイルへ残さないことを
// この試験で固定します（将来リファクタでマスクを外さないための錠前です）。

test('貼り付けて再実行できる1行へ、実行ファイルと引数を復元する', () => {
  // 安全な文字だけの引数（パス・モデル名）は可読性のため素通しします。
  assert.equal(commandLine('kilo', ['run', '--model', 'kilo/kilo-auto/free', 'KILO_HEALTH_OK']), 'kilo run --model kilo/kilo-auto/free KILO_HEALTH_OK');
  // 空白を含む依頼文は二重引用符で括ります（execFileの引数配列と同じ解釈になります）。
  assert.equal(commandLine('crush', ['run', '--quiet', '読み取り専用の 接続検証 です']), 'crush run --quiet "読み取り専用の 接続検証 です"');
  // 空引数は消さずに保持します（素通しすると引数そのものが消えて再現できなくなります）。
  assert.equal(commandLine('goose', ['--text', '']), 'goose --text ""');
});

test('引用符とバックスラッシュはWindowsのコマンド行解釈に合わせて補う', () => {
  // 内側の二重引用符は \" へ、直前のバックスラッシュ列は倍化してから引用符を閉じます。
  assert.equal(commandLine('python', ['-c', 'print("x")']), 'python -c "print(\\"x\\")"');
  // 末尾バックスラッシュは引用符の中へ吸収されないよう二重にします。
  assert.equal(commandLine('cmd', ['C:\\Users\\you k\\']), 'cmd "C:\\Users\\you k\\\\"');
  // 改行を含む発言本文は、貼り付け時に複数行コマンドへ崩れないよう空白へ正規化します。
  assert.equal(commandLine('hermes', ['1行目\n2行目']), 'hermes "1行目 2行目"');
});

test('認証情報らしき値は、表示・保存前に必ずマスクする', () => {
  // ①`--api-key <値>`（引数が分かれた形。execFileの実際の引数配列相当）。
  assert.match(commandLine('claude', ['--api-key', 'super-secret-value']), /--api-key \*{8}$/);
  // ②`--api-key=<値>`（1引数に結合した形）。
  assert.match(commandLine('tool', ['--api-key=super-secret-value']), /--api-key=\*{8}/);
  // ③ヘッダ値を直接引数へ渡す形。閉じ引用符を巻き込まず、貼り付けたまま実行できる形を保ちます。
  assert.equal(commandLine('tool', ['--header', 'Authorization: Bearer abc.def']), 'tool --header "Authorization: Bearer ********"');
  // ④接頭辞付きキーは最終防衛線でマスクします。
  assert.match(redactCommandSecrets('openai sk-abcdef1234567890'), /sk-\*{8}/);
  // マスク後も再実行に必要十分な部分（実行ファイル・モデル指定）は残します。
  assert.equal(commandLine('codex', ['exec', '--model', 'gpt-5', '--api-key', 'top-secret']), 'codex exec --model gpt-5 --api-key ********');
});

test('モデル名・依頼文などの正常な値はマスクしない', () => {
  const line = commandLine('opencode', ['run', '--model', 'opencode/nemotron-3-ultra-free', 'WENTIAN_CONNECTION_OK_OPENCODEだけを返してください。']);
  assert.match(line, /--model opencode\/nemotron-3-ultra-free/);
  assert.match(line, /"WENTIAN_CONNECTION_OK_OPENCODEだけ/);
  assert.doesNotMatch(line, /\*{8}/);
});

test('失敗オブジェクトのcommandから表示用行を取り出し、不明時は空文字にする', () => {
  const error = Object.assign(new Error('Command failed: python maintain-agent-connection.py --api-key leaked-value'), { command: 'python bridge.py --api-key leaked-value' });
  assert.equal(failedCommandOf(error), 'python bridge.py --api-key ********');
  // 実行ファイル確定前の失敗（起動失敗・中断）は空文字とし、補足列で空欄を出しません。
  assert.equal(failedCommandOf(new Error('CLIの生存確認が成功していません。')), '');
  assert.equal(failedCommandOf(undefined), '');
  // 文字列以外のcommand（オブジェクト等）は表示不能として無視します。
  assert.equal(failedCommandOf({ command: { executable: 'kilo' } }), '');
});
