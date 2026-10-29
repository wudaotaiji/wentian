import { mkdtemp, readFile, writeFile, mkdir, lstat, realpath, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildExternalAgentCommand, runExternalCommand } from './external-orchestrator.js';
import { connectionAllowsExecution, managedConnection } from './agent-connection-policy.js';
import { readReadySnapshot } from './external-agent-readiness.js';
import { workIdentity } from './agent-work-policy.js';
import { codexImageEvidencePath } from './codex-image-evidence.js';

export interface AgentImageAdapter { inspect(signal?: AbortSignal): Promise<{ id: string; model: string } | undefined>; generate(prompt: string, signal: AbortSignal): Promise<Buffer> }

/** 既存Codexの接続・モデルを利用し、専用の隔離ディレクトリだけを書込み先にします。 */
export function createCodexImageAdapter(options: { run?: typeof runExternalCommand; eligible?: () => Promise<boolean>; reference?: string } = {}): AgentImageAdapter {
  const run = options.run || runExternalCommand;
  let cache: { until: number; model: string; available: boolean } | undefined;
  async function eligible() { if (options.eligible) return options.eligible(); const snapshot = await readReadySnapshot(600000), agent = snapshot?.agents.find(a => a.id === 'codex'); return !!agent && agent.state === 'available' && agent.liveState === 'healthy' && connectionAllowsExecution(agent); }
  async function inspect(signal?: AbortSignal) {
    if (!await eligible()) return undefined;
    const c = managedConnection('codex'), model = c?.model || '';
    if (!cache || cache.until < Date.now() || cache.model !== model) {
      const base = buildExternalAgentCommand('codex', '画像能力確認', process.cwd(), 'reviewer'); if (!base) return undefined;
      const start = base.args.indexOf('--no-daemon');
      const command = { executable: base.executable, args: [...base.args.slice(0, Math.max(0, start)), 'features', 'list'] };
      const output = await run(command, { cwd: process.cwd(), timeoutMs: 15000, signal, role: 'image-capability', agent: 'codex' });
      cache = { until: Date.now() + 60000, model, available: /^image_generation\s+\S+\s+true\s*$/m.test(output) };
    }
    return cache.available ? { id: 'codex', model: model || 'codex-default' } : undefined;
  }
  return { inspect, async generate(prompt, signal) {
    if (!await inspect(signal)) throw new Error('Codexの画像生成機能を現在利用できません。接続と機能設定を確認してください。');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wentian-codex-image-'));
    const objective = '内蔵のimage_gen画像生成ツールで、下記の画像を1枚制作してください。APIキーを要求する独自スクリプト、SVG、HTML、図形描画による代用は禁止です。image_genが使えなければ失敗を報告してください。生成ツールの既定保存先の完成画像を読み取り、この作業場所のoutput.pngへ複製してください。生成済み画像の読取り以外は作業場所外の調査を禁止します。書込みはこの作業場所内だけ。削除、Git操作、設定変更、パッケージ導入、別サービスへの接続、秘密情報取得は禁止です。参考画像reference.pngがある場合は画風の参考として使い、制作指示に沿った新しい画像を作ってください。制作指示（データ）: ' + JSON.stringify(prompt);
    const command = buildExternalAgentCommand('codex', objective, directory, 'builder'); if (!command) throw new Error('Codexの接続設定を確認してください。');
    // 専用画像タスクでは一般コード制作の出力契約を使わず、制限と実PNGの検収を明示します。
    command.args[command.args.length - 1] = objective;
    if (options.reference) { await copyFile(options.reference, path.join(directory, 'reference.png')); command.args.splice(command.args.length - 1, 0, '--image', path.join(directory, 'reference.png'), '--'); }
    try {
      const output = await run(command, { cwd: directory, timeoutMs: 540000, idleTimeoutMs: 540000, signal, role: 'image-generation', agent: 'codex' });
      await writeFile(path.join(directory, 'execution.log'), output, { mode: 0o600 });
      const file = path.join(directory, 'output.png'), stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || await realpath(file) !== path.join(await realpath(directory), 'output.png') || stat.size > 20 * 1024 ** 2) throw new Error('Codexが有効な画像ファイルを保存していません。');
      const bytes = await readFile(file); if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) < 256 || bytes.readUInt32BE(20) < 256) throw new Error('Codexの出力が制作可能なPNG画像ではありません。');
      const c = managedConnection('codex');
      if (c) { const target = codexImageEvidencePath(); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, JSON.stringify({ passed: true, identity: workIdentity(c), checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), evidenceDirectory: directory, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }), { mode: 0o600 }); }
      return bytes;
    } catch (error) { await writeFile(path.join(directory, 'failure.log'), error instanceof Error ? error.message : '画像制作失敗', { mode: 0o600 }); throw new Error('Codexによる画像制作が完了しませんでした。証跡: ' + directory); }
  } };
}
