import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadProviderFile } from './config.js';
import { processAlive, readDaemonRecord } from './cli-runtime.js';
import { readReadySnapshot } from './external-agent-readiness.js';

export type DoctorStatus = 'ok' | 'warning' | 'error';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  remediation?: string;
}

export interface DoctorReport {
  generatedAt: string;
  baseUrl: string;
  status: DoctorStatus;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

const severity: Record<DoctorStatus, number> = { ok: 0, warning: 1, error: 2 };

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function requestJson(fetcher: typeof fetch, url: string, init?: RequestInit): Promise<{ status: number; payload: any }> {
  // 初回HealthはProviderの起動確認と重なる場合があるため、通常のAPI要求より長い15秒を許容します。
  // 無期限待機にはせず、診断コマンド単体で必ず終了できる上限を維持します。
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  let payload: any;
  try { payload = JSON.parse(text); } catch { payload = text; }
  return { status: response.status, payload };
}

/**
 * Wentianの主要な利用経路を読み取り専用で診断します。
 * 状態変更APIや外部モデルへの推論要求は実行せず、Health・構成・MCP初期化だけを確認します。
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env || process.env;
  const fetcher = options.fetcher || fetch;
  const record = await readDaemonRecord().catch(() => undefined);
  const baseUrl = (options.baseUrl || (record ? `http://${record.hostname}:${record.port}` : 'http://127.0.0.1:8787')).replace(/\/$/, '');
  const checks: DoctorCheck[] = [];

  if (record && processAlive(record.pid)) checks.push({ id: 'daemon', label: 'Gateway Daemon', status: 'ok', detail: `PID ${record.pid}、${baseUrl}` });
  else checks.push({ id: 'daemon', label: 'Gateway Daemon', status: 'warning', detail: '稼働中のDaemon台帳を確認できません。', remediation: 'wentian daemon start --port 8787' });

  try {
    const health = await requestJson(fetcher, `${baseUrl}/health`);
    checks.push(health.status === 200 && health.payload?.ok
      ? { id: 'health', label: 'Gateway Health', status: 'ok', detail: 'HTTP 200 / ok=true' }
      : { id: 'health', label: 'Gateway Health', status: 'error', detail: `HTTP ${health.status} / ok=trueではありません。`, remediation: 'wentian daemon restart --port 8787' });
  } catch (error) {
    checks.push({ id: 'health', label: 'Gateway Health', status: 'error', detail: error instanceof Error ? error.message : String(error), remediation: 'wentian daemon start --port 8787' });
  }

  try {
    const models = await requestJson(fetcher, `${baseUrl}/v1/models`);
    const count = Array.isArray(models.payload?.data) ? models.payload.data.length : 0;
    checks.push(models.status === 200 && count > 0
      ? { id: 'models', label: 'Model Catalog', status: 'ok', detail: `${count}モデルを公開中です。` }
      : { id: 'models', label: 'Model Catalog', status: 'warning', detail: `利用可能なモデルを確認できません（HTTP ${models.status}）。`, remediation: 'providers.jsonと各Providerの起動状態を確認してください。' });
  } catch (error) {
    checks.push({ id: 'models', label: 'Model Catalog', status: 'warning', detail: error instanceof Error ? error.message : String(error), remediation: 'Gateway起動後に再実行してください。' });
  }

  try {
    const mcp = await requestJson(fetcher, `${baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wentian-doctor', version: '1.0' } } }) });
    checks.push(mcp.status === 200 && mcp.payload?.result?.serverInfo
      ? { id: 'mcp', label: 'MCP Endpoint', status: 'ok', detail: `${mcp.payload.result.serverInfo.name || 'server'}へ接続できました。` }
      : { id: 'mcp', label: 'MCP Endpoint', status: 'warning', detail: `MCPが無効または応答不正です（HTTP ${mcp.status}）。`, remediation: 'WENTIAN_ENABLE_MCP=trueを設定してDaemonを再起動してください。' });
  } catch (error) {
    checks.push({ id: 'mcp', label: 'MCP Endpoint', status: 'warning', detail: error instanceof Error ? error.message : String(error), remediation: 'WENTIAN_ENABLE_MCP=trueとGateway状態を確認してください。' });
  }

  try {
    const providers = loadProviderFile(env.WENTIAN_PROVIDERS_FILE || path.join(env.WENTIAN_INSTALL_ROOT || process.cwd(), 'providers.json'));
    const enabled = providers.filter(provider => provider.enabled);
    checks.push(enabled.length
      ? { id: 'providers', label: 'Provider Configuration', status: 'ok', detail: `${enabled.length}/${providers.length} Providerが有効です。` }
      : { id: 'providers', label: 'Provider Configuration', status: 'error', detail: '有効なProviderがありません。', remediation: 'providers.jsonで1件以上のProviderを有効化してください。' });
  } catch (error) {
    checks.push({ id: 'providers', label: 'Provider Configuration', status: 'error', detail: error instanceof Error ? error.message : String(error), remediation: 'providers.jsonの形式とURLを修正してください。' });
  }

  const home = options.homeDirectory || env.USERPROFILE || env.HOME || '';
  const clients = [
    { id: 'opencode', label: 'OpenCode Configuration', file: path.join(home, '.config', 'opencode', 'opencode.jsonc') },
    { id: 'kilo', label: 'Kilo Configuration', file: path.join(home, '.config', 'kilo', 'kilo.jsonc') },
  ];
  for (const client of clients) {
    if (!home || !(await exists(client.file))) {
      checks.push({ id: client.id, label: client.label, status: 'warning', detail: '設定ファイルが見つかりません。', remediation: `利用する場合は${client.file}へWentian Providerを登録してください。` });
      continue;
    }
    const configured = (await readFile(client.file, 'utf8')).includes('wentian');
    checks.push(configured
      ? { id: client.id, label: client.label, status: 'ok', detail: 'Wentian設定を検出しました。' }
      : { id: client.id, label: client.label, status: 'warning', detail: '設定ファイルにWentian定義がありません。', remediation: 'READMEのCustom Provider設定を追加してください。' });
  }

  const ready = await readReadySnapshot(24 * 60 * 60 * 1000).catch(() => undefined);
  const readyCount = ready?.agents.filter(agent => agent.state === 'available' && agent.liveState === 'healthy').length || 0;
  checks.push(readyCount > 0
    ? { id: 'external-agents', label: 'External Agent Cache', status: 'ok', detail: `${readyCount}件のReady Agentを確認しました。` }
    : { id: 'external-agents', label: 'External Agent Cache', status: 'warning', detail: '24時間以内のReady Agentキャッシュがありません。', remediation: 'Gatewayを起動し、バックグラウンド生存確認の完了後に再実行してください。' });

  const status = checks.reduce<DoctorStatus>((current, check) => severity[check.status] > severity[current] ? check.status : current, 'ok');
  return { generatedAt: new Date().toISOString(), baseUrl, status, checks };
}

/** 診断結果を端末で読みやすい日本語へ整形します。 */
export function formatDoctorReport(report: DoctorReport): string {
  const mark: Record<DoctorStatus, string> = { ok: '[OK]', warning: '[WARN]', error: '[ERROR]' };
  const lines = [`Wentian Doctor: ${report.status.toUpperCase()}`, `Base URL: ${report.baseUrl}`];
  for (const check of report.checks) {
    lines.push(`${mark[check.status]} ${check.label}: ${check.detail}`);
    if (check.remediation) lines.push(`  修正案: ${check.remediation}`);
  }
  return lines.join('\n');
}
