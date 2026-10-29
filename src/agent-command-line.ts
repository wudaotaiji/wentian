/**
 * 外部エージェントの起動コマンドを、作業者が端末へそのまま貼り付けて再実行できる1行へ復元します。
 *
 * 背景: Gatewayは外部CLIを `execFile`（Shellを通さない引数配列起動）で実行するため、
 * 失敗時に保存されるのは終了コードと診断本文だけでした。補足列から手動確認するには
 * 起動に使われた実行ファイルと引数が必要ですが、Windowsのコマンド行規則を再現しないと
 * 貼り付けたときに解釈がずれます。そこでCommandLineToArgvW相当の引用符補いをこのモジュールへ集約します。
 *
 * 秘密情報の扱い: 補足列・証跡JSON・保存ファイルへ載せるため、APIキー・トークン・
 * パスワードらしい値は必ずマスクします。環境変数の値と応答本文はそもそも引数へ含まれませんが、
 * 引数経由で渡される認証値（`--api-key <値>` 等）に備えて防御的に除去します。
 */

/** 認証情報らしきオプション名（値をマスクする対象）。 */
const SECRET_OPTION = /-{1,2}(?:api[-_]?key|access[-_]?token|token|secret[-_]?key|secret|password|passwd|auth[-_]?token|authorization)/i;

/**
 * コマンド行文字列から認証情報らしき値を `********` へ置き換えます。
 * ①`--api-key=<値>`、②`--api-key <値>`、③`Bearer <値>`、④`sk-...`形式のキーを対象にします。
 */
export function redactCommandSecrets(line: string): string {
  let value = String(line || '');
  // ①`--api-key=<値>` と ②`--api-key <値>`（オプション名と値が離れている形）。
  // 値の終端を空白か引用符の直前までとすることで、`"鍵 値"` の閉じ引用符を巻き込んで
  // 貼り付け時に壊れる（引用符が1つ欠ける）ことを防ぎます。
  value = value.replace(new RegExp(`(${SECRET_OPTION.source})([=\\s]+)(?:"[^"]*"|[^\\s"]+)`, 'gi'), '$1$2********');
  // Authorizationヘッダ相当を直接引数へ渡す場合に備えます。
  value = value.replace(/\bBearer\s+(?:"[^"]*"|[^\s"]+)/gi, 'Bearer ********');
  // 接頭辞付きの公開キー形式（OpenAI等）を最終防衛線としてマスクします。
  value = value.replace(/\bsk-[A-Za-z0-9_.-]{10,}/g, 'sk-********');
  return value;
}

/** 引数配列を監査記録用に整え、秘密オプションとその値をマスクします。 */
export function redactCommandArguments(args: string[]): string[] {
  let maskNext = false;
  return args.map(raw => {
    const value = String(raw ?? '');
    if (maskNext) { maskNext = false; return '********'; }
    const secretOption = SECRET_OPTION.test(value);
    SECRET_OPTION.lastIndex = 0;
    if (secretOption && !/[=\s]/.test(value)) maskNext = true;
    return redactCommandSecrets(value);
  });
}

/**
 * 1つの引数をWindowsコマンド行の規則で引用符補いします。
 * 安全な文字だけで構成される値（パス・モデル名など）は素通しし、
 * それ以外は二重引用符で括ります。二重引用符と末尾のバックスラッシュは
 * CommandLineToArgvWの解釈に合わせてエスケープします。
 */
function quoteWindowsArg(value: string): string {
  const token = String(value ?? '');
  // 改行を含む値（グループ会話で発言本文がそのまま引数になる経路）は、
  // 端末へ貼り付けたときに複数行コマンドへ崩れないよう空白正規化します。本文の意味は保たれます。
  const single = token.replace(/\r?\n/g, ' ');
  // 引用符が不要な文字だけなら素通し（可読性を優先）。
  if (single.length && /^[\w@./:\\+=,-]+$/.test(single)) return single;
  // 空文字は明示的な空引数として残します（素通しすると引数自体が消える）。
  if (!token.length) return '""';
  // 内側の " を \" へ、直前のバックスラッシュ列を倍化してから引用符を閉じます。
  const escaped = single.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * `execFile` の起動引数から、貼り付けて再実行できるコマンド行を作ります。
 * 戻り値には秘密値を含めません（保存・表示前提）。
 */
export function commandLine(executable: string, args: string[] = []): string {
  const line = [String(executable || ''), ...(Array.isArray(args) ? args : []).map(arg => quoteWindowsArg(String(arg)))].join(' ');
  return redactCommandSecrets(line).trim();
}

/**
 * 失敗オブジェクト（`executeExternalCommand` が付与した `command`）から
 * 表示・保存用のコマンド行を取り出します。無ければ空文字（補足列では非表示）。
 */
export function failedCommandOf(error: unknown): string {
  const command = (error as { command?: unknown } | undefined)?.command;
  return typeof command === 'string' ? redactCommandSecrets(command) : '';
}
