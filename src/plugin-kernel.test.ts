import assert from 'node:assert/strict';
import test from 'node:test';
import { WentianPluginKernel, serviceKey, type WentianPluginDefinition } from './plugin-kernel.js';

const VALUE = serviceKey<string>('test.value');
const definition = (id: string, value: string, requires: string[] = []): WentianPluginDefinition => ({
  id, kind: 'tool', version: '1.0.0', requires, setup: context => { context.provide(VALUE, value); },
});

test('Service ProviderをOverlayし、unload時に直前Providerへ戻す', async () => {
  const kernel = new WentianPluginKernel();
  kernel.register(definition('base', 'base'));
  kernel.register(definition('overlay', 'overlay', ['base']));
  await kernel.load([{ id: 'overlay' }, { id: 'base' }]);
  assert.equal(kernel.resolve(VALUE), 'overlay');
  await kernel.unload('overlay');
  assert.equal(kernel.resolve(VALUE), 'base');
});

test('依存関係の循環をロード前に拒否する', async () => {
  const kernel = new WentianPluginKernel();
  kernel.register(definition('a', 'a', ['b']));
  kernel.register(definition('b', 'b', ['a']));
  await assert.rejects(kernel.load([{ id: 'a' }, { id: 'b' }]), /循環/);
});

test('Plugin初期化失敗時に今回ロード分をRollbackする', async () => {
  const kernel = new WentianPluginKernel();
  kernel.register(definition('base', 'base'));
  kernel.register({ id: 'broken', kind: 'loop', version: '1.0.0', requires: ['base'], setup: () => { throw new Error('broken'); } });
  await assert.rejects(kernel.load([{ id: 'base' }, { id: 'broken' }]), /broken/);
  assert.equal(kernel.has('base'), false);
  assert.equal(kernel.optional(VALUE), undefined);
});

test('Plugin Eventを連番のAppend-only Trajectoryとして記録する', async () => {
  const kernel = new WentianPluginKernel();
  kernel.register({ id: 'observer', kind: 'memory', version: '1.0.0', setup: context => { context.on('custom', async detail => { await context.emit('observed', detail); }); } });
  kernel.register({ id: 'sender', kind: 'scheduler', version: '1.0.0', requires: ['observer'], setup: async context => { await context.emit('custom', { ok: true }); } });
  await kernel.load([{ id: 'observer' }, { id: 'sender' }]);
  const events = kernel.snapshot().events;
  assert.ok(events.some(event => event.type === 'custom'));
  assert.deepEqual(events.map(event => event.sequence), events.map((_event, index) => index + 1));
});

test('管理SnapshotではPlugin Event内の秘密情報を伏字化する', async () => {
  const kernel = new WentianPluginKernel();
  kernel.register({ id: 'safe-events', kind: 'storage', version: '1.0.0', setup: async context => { await context.emit('audit', { apiKey: 'secret-value', nested: { token: 'token-value', result: 'ok' } }); } });
  await kernel.load([{ id: 'safe-events' }]);
  const detail = kernel.snapshot().events.find(event => event.type === 'audit')?.detail as any;
  assert.deepEqual(detail, { apiKey: '[REDACTED]', nested: { token: '[REDACTED]', result: 'ok' } });
});
