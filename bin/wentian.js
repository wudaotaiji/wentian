#!/usr/bin/env node
// WindowsではOpenCode/Kiloと同じBunランタイムで起動し、OpenTUIのネイティブFFIを利用します。
// それ以外の環境では、従来どおりNode.jsとtsxランタイムへ安全に縮退します。
import { spawn } from 'node:child_process';
import { openSync, readSync, closeSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 最小内核は既存CLIの一括importとBun依存を避け、Node.jsだけで起動します。
const nodeCore = process.argv[2] === 'node-core';
const source = nodeCore ? path.join(root, 'src', 'cloud-federation', 'node-entry.ts') : path.join(root, 'src', 'cli.ts');
const bunArchitecture = process.arch === 'arm64' ? 'bun-windows-aarch64' : 'bun-windows-x64';
// npmは任意依存をbun配下へ配置する場合があります。公開されたbinを優先し、
// 旧配置も確認します。巻き上げ（hoisting）の有無へ依存した固定パスにしません。
let bunPackage;
try { bunPackage = createRequire(import.meta.url).resolve('bun/package.json'); } catch { /* 未導入は下で案内します。 */ }
const bun = [
  ...(bunPackage ? [path.join(path.dirname(bunPackage), 'bin', 'bun.exe')] : []),
  path.join(root, 'node_modules', '@oven', bunArchitecture, 'bin', 'bun.exe'),
  ...(bunPackage ? [path.join(path.dirname(bunPackage), 'node_modules', '@oven', bunArchitecture, 'bin', 'bun.exe')] : []),
].find(candidate => {
  // npmの未導入案内がbun.exeとして残る場合があるため、PE形式の先頭署名を確認します。
  let descriptor;
  try {
    descriptor = openSync(candidate, 'r');
    const signature = Buffer.alloc(2);
    return readSync(descriptor, signature, 0, 2, 0) === 2 && signature.toString('ascii') === 'MZ';
  } catch { return false; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
});
if (!nodeCore && process.platform === 'win32' && !bun) {
  console.error('Wentian用のBunが見つかりません。導入先で npm install --include=dev --include=optional を実行してください。');
  process.exit(1);
}
const executable = !nodeCore && process.platform === 'win32' ? bun : process.execPath;
const runtimeArguments = !nodeCore && process.platform === 'win32'
  ? [source]
  : [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), source];
// 設定・Daemon台帳はインストール元、Agentのファイル操作対象は呼出し元cwdとして分離します。
let restarts = 0;
function launch() {
  const child = spawn(executable, [...runtimeArguments, ...process.argv.slice(nodeCore ? 3 : 2)], { cwd: process.cwd(), stdio: 'inherit', windowsHide: false, env: { ...process.env, WENTIAN_INSTALL_ROOT: root } });
  child.once('error', error => { console.error('Wentianランタイムを起動できません:', error.message); process.exitCode = 1; });
  child.once('exit', code => {
    // AIからの内核再起動要求だけを扱い、繰り返し故障時の無限再起動を防ぎます。
    if (nodeCore && code === 75 && restarts++ < 3) { setTimeout(launch, 1000); return; }
    process.exitCode = code ?? 1;
  });
}
launch();
