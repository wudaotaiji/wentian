import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatDoctorReport, runDoctor } from './doctor.js';

test('DoctorはHealth・Model・MCP・Client設定を一括診断する', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-doctor-'));
  const home = path.join(root, 'home');
  const providers = path.join(root, 'providers.json');
  await mkdir(path.join(home, '.config', 'opencode'), { recursive: true });
  await mkdir(path.join(home, '.config', 'kilo'), { recursive: true });
  await writeFile(path.join(home, '.config', 'opencode', 'opencode.jsonc'), '{ "provider": { "wentian": {} } }');
  await writeFile(path.join(home, '.config', 'kilo', 'kilo.jsonc'), '{ "provider": { "wentian": {} } }');
  await writeFile(providers, JSON.stringify({ providers: [{ id: 'test-provider', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true }] }));
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'wentian-auto/local' }] }), { status: 200 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'wentian-gateway' } } }), { status: 200 });
  }) as typeof fetch;
  try {
    const report = await runDoctor({ baseUrl: 'http://127.0.0.1:8787', fetcher, homeDirectory: home, env: { WENTIAN_PROVIDERS_FILE: providers, WENTIAN_INSTALL_ROOT: root } });
    assert.equal(report.checks.find(check => check.id === 'health')?.status, 'ok');
    assert.equal(report.checks.find(check => check.id === 'models')?.status, 'ok');
    assert.equal(report.checks.find(check => check.id === 'mcp')?.status, 'ok');
    assert.equal(report.checks.find(check => check.id === 'opencode')?.status, 'ok');
    assert.match(formatDoctorReport(report), /Wentian Doctor/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Doctorは接続失敗を例外終了せず修正案として報告する', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-doctor-fail-'));
  const providers = path.join(root, 'providers.json');
  await writeFile(providers, JSON.stringify({ providers: [] }));
  const fetcher = (async () => { throw new Error('接続できません'); }) as typeof fetch;
  try {
    const report = await runDoctor({ fetcher, homeDirectory: path.join(root, 'none'), env: { WENTIAN_PROVIDERS_FILE: providers, WENTIAN_INSTALL_ROOT: root } });
    assert.equal(report.status, 'error');
    assert.equal(report.checks.find(check => check.id === 'health')?.status, 'error');
    assert.ok(report.checks.some(check => check.remediation));
  } finally { await rm(root, { recursive: true, force: true }); }
});
