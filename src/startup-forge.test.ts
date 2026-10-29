import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { registerWorkbench } from './workbench.js';
import { parseForgePlan } from './startup-forge.js';
import { loadGoal } from './goal-store.js';

const plan = { name: '地域工房', proposition: '地域の工房の空き時間を予約できる', customers: '地元の作り手', validation: '利用者に聞き、予約実験で需要を検証する', risks: ['需要は未確認'], team: [{ name: '調査担当', role: '需要と制約を調べる' }], tasks: [{ id: 'research', title: '需要調査', owner: '調査担当', description: '仮説を調査する', deliverable: '調査記録', acceptance: '根拠と未確認事項がある', dependsOn: [] as string[] }, { id: 'prototype', title: '予約試作', owner: '調査担当', description: '調査に基づいて試作する', deliverable: '試作画面', acceptance: '予約の流れを検証できる', dependsOn: ['research'] }] };

test('AI計画は固定の担当を強制せず、架空の担当と循環・前方依存を拒否する', () => {
  assert.equal(parseForgePlan(JSON.stringify(plan)).team[0].name, '調査担当');
  const wrong = structuredClone(plan); wrong.tasks[0].dependsOn = ['prototype'];
  assert.throws(() => parseForgePlan(JSON.stringify(wrong)), /依存関係/);
  wrong.tasks[0].dependsOn = []; wrong.tasks[0].owner = '未登録';
  assert.throws(() => parseForgePlan(JSON.stringify(wrong)), /担当/);
});

test('AI生成失敗は状態へ記録し、タスクを作成せず再生成できる', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-forge-error-')), app = Fastify();
  registerWorkbench(app, { workspace: root, authorize: () => true, models: async () => [], providerSaved: () => {}, testModel: async () => 'ok', groupRespond: async () => '不正な計画' });
  try {
    const group = (await app.inject({ method: 'POST', url: '/api/workbench/groups', payload: { title: '構想', names: ['担当'] } })).json();
    const url = '/api/workbench/groups/' + group.id + '/forge';
    await app.inject({ method: 'POST', url: url + '/plan', payload: { brief: '検証する' } });
    let state: any;
    for (let i = 0; i < 100; i++) { state = (await app.inject(url)).json().state; if (state?.status === 'error') break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(state.status, 'error'); assert.equal(state.goalId, undefined);
    assert.equal((await app.inject({ method: 'POST', url: url + '/register', payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: url + '/plan', payload: { brief: '' } })).statusCode, 400);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('群の構想を非同期にAI計画へ変換し、依存関係と検収条件を保って一度だけタスク登録する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-forge-')), app = Fastify();
  registerWorkbench(app, { workspace: root, authorize: (req, reply) => { if (req.headers.authorization === 'Bearer test') return true; reply.code(401).send({ error: '認証が必要です。' }); return false; }, models: async () => [], providerSaved: () => {}, testModel: async () => 'ok', groupRespond: async (_member, messages, context) => {
    assert.equal(context?.startupPlanning, true); assert.ok(messages[1].content.includes('地域の工房')); return JSON.stringify(plan);
  } });
  const headers = { authorization: 'Bearer test' };
  try {
    const group = (await app.inject({ method: 'POST', url: '/api/workbench/groups', headers, payload: { title: '工房の相談', names: ['構想担当'] } })).json();
    const url = '/api/workbench/groups/' + group.id + '/forge';
    assert.equal((await app.inject(url)).statusCode, 401);
    const start = await app.inject({ method: 'POST', url: url + '/plan', headers, payload: { brief: '地域の工房の予約事業を検証する' } });
    assert.equal(start.statusCode, 200, start.body);
    let saved: any;
    for (let i = 0; i < 100; i++) { saved = (await app.inject({ url, headers })).json(); if (saved.state?.status !== 'planning') break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(saved.state.status, 'ready');
    const registered = (await app.inject({ method: 'POST', url: url + '/register', headers, payload: {} })).json();
    const goal = await loadGoal(registered.state.goalId);
    assert.equal(goal.status, 'paused'); assert.equal(goal.todos.length, 2);
    assert.deepEqual(goal.todos[1].dependsOn, [goal.todos[0].id]); assert.ok(goal.todos[0].description?.includes('検収条件'));
    const again = (await app.inject({ method: 'POST', url: url + '/register', headers, payload: {} })).json();
    assert.equal(again.state.goalId, goal.id);
    const view = (await app.inject({ url, headers })).json(); assert.equal(view.goal.tasks.length, 2);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
