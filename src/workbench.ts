import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import path from 'node:path';
import { open } from 'node:fs/promises';
import { addTodo, consumeGoalPause, createGoal, deleteGoal, goalPath, listGoals, loadGoal, requestGoalPause, saveGoal, type GoalStore } from './goal-store.js';
import { isPidAlive, readDaemonRecord, startGoalDaemon } from './goal-daemon.js';
import { validateAcceptance, verifyDelivery } from './delivery-verification.js';
import { listSkills, loadSkillPresentation } from './skills.js';
import { listAgentSessions } from './agent-session.js';
import { workbenchHtml } from './workbench-ui.js';
import { groupManagementHtml } from './group-management-ui.js';
import { registerGroupManagementRoutes } from './group-management.js';
import { registerStartupForge } from './startup-forge.js';
import { startupForgeRoomHtml } from './startup-forge-room.js';
import { loadForgeScene, saveForgeScene } from './forge-scene.js';
import { builtinVisualAssets, listVisualAssets, registerVisualAssets } from './visual-assets.js';
import { visualAssetsHtml } from './visual-assets-ui.js';
import type { WentianImageRuntime } from './wentian-image-runtime.js';
import { readFile } from 'node:fs/promises';
import { AgentGroupStore, namedMembers, type GroupResponder, type GroupAvatar } from './agent-group.js';
import { topicMembers } from './group-topic-members.js';
import { parseGroupMentions } from './group-mentions.js';
import type { PublicGuestPost } from './public-guest.js';
import { registerDirectMessages, type DmPerson } from './direct-messages.js';
import type { ProviderConfig } from './config.js';
import { saveOnboardingProvider } from './onboarding.js';

export interface WorkbenchOptions {
  groupKnowledgeAccess?:(req:FastifyRequest,id:string)=>Promise<boolean>;
  directMessagePeople?: () => DmPerson[];
  registerPublicPost?: (post: PublicGuestPost) => void;
  studyRoot?: (groupId?: string) => Promise<string | undefined>;
  imageRuntime?: WentianImageRuntime;
  groupRespond?: GroupResponder;
  groupActionRespond?: (member: Parameters<GroupResponder>[0], messages: Parameters<GroupResponder>[1], execution: import('./agent-group.js').GroupExecutionSettings, signal?: AbortSignal) => ReturnType<GroupResponder>;
  /** 常駐の自律討論を、人間の発言・停止操作から停止するための窓口です。 */
  groupAutonomy?: { humanActivity: (id: string) => Promise<unknown>; stop: (id: string) => Promise<unknown>; resumeAfterHuman?: (id: string) => Promise<unknown> };
  groupModels?: () => Promise<Array<{ id: string }>>;
  workspace: string;
  authorize: (req: FastifyRequest, reply: FastifyReply) => boolean;
  groupIdentity?: (req: FastifyRequest) => { id: string; name: string; admin: boolean } | undefined;
  models: () => Promise<Array<{ id: string }>>;
  saveProvider?: typeof saveOnboardingProvider;
  providerSaved: (provider: ProviderConfig) => void;
  testModel: (model: string) => Promise<string>;
  start?: typeof startGoalDaemon;
}

/** 全操作は管理者認証下で、サーバーが固定した1つの作業領域だけを対象にします。 */
export function registerWorkbench(app: FastifyInstance, options: WorkbenchOptions): void {
  const workspace = path.resolve(options.workspace);
  registerDirectMessages(app, { workspace, identity: req => options.groupIdentity?.(req), people: options.directMessagePeople || (() => []) });
  const busy = new Set<string>();
  // 人間の投稿を即時保存し、AI返答はグループごとのキュー（Queue）で直列化します。
  const humanReplyQueues = new Map<string, Promise<unknown>>();
  const shutdown = new AbortController();
  app.addHook('onClose', async () => {
    shutdown.abort(new Error('Gatewayの終了により群の成果作成を停止しました。'));
    await Promise.allSettled([...humanReplyQueues.values()]);
  });
  const active = async (id: string) => { const record = await readDaemonRecord(id); return Boolean(record && record.status !== 'dead' && await isPidAlive(record.pid)); };
  const belongs = (goal: GoalStore) => path.resolve(goal.workspace || workspace) === workspace;
  const get = async (id: string) => { goalPath(id); const goal = await loadGoal(id); if (!belongs(goal)) throw new Error('別のワークスペースのタスクです。'); return goal; };
  const idle = async (id: string) => { if (await active(id)) throw new Error('実行中です。ステップ完了時に一時停止してから変更してください。'); };
  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    // 人間の会話参加は認証済み利用者へ開き、モデル実行や設定変更は管理者に限定します。
    const conversation = (req.method === 'GET' && /^\/api\/workbench\/(groups(?:\/[^/]+)?|group-models)$/.test(req.url.split('?')[0])) || /^\/api\/workbench\/groups\/[^/]+\/(join|leave|presence|messages|avatar)$/.test(req.url.split('?')[0]);
    if (!(conversation && options.groupIdentity?.(req)) && !options.authorize(req, reply)) return reply;
    const groupId=/^\/api\/workbench\/groups\/(group-[a-f0-9-]{36})(?:\/|$)/.exec(req.url.split('?')[0])?.[1];
    if(groupId&&options.groupKnowledgeAccess&&!await options.groupKnowledgeAccess(req,groupId))return reply.code(403).send({error:{message:'この知識庫グループを閲覧・操作する権限がありません。'}});
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && origin !== `${req.protocol}://${req.headers.host}`) return reply.code(403).send({ error: { message: '同じサイトから操作してください。' } });
  };
  const mutate = async (id: string, operation: () => Promise<unknown>) => {
    if (busy.has(id)) throw new Error('別の操作が処理中です。');
    busy.add(id); try { return await operation(); } finally { busy.delete(id); }
  };
  app.get('/workbench', async (_req, reply) => reply.type('text/html; charset=utf-8').send(workbenchHtml));
  app.get('/workbench/groups', async (_req, reply) => reply.type('text/html; charset=utf-8').send(groupManagementHtml));
  app.get('/startup-forge', async (_req, reply) => reply.type('text/html; charset=utf-8').send(startupForgeRoomHtml(workbenchHtml)));
  app.get('/visual-assets', async (_req, reply) => reply.type('text/html; charset=utf-8').send(visualAssetsHtml));
  app.get('/assets/startup-forge/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!builtinVisualAssets.some(asset => asset.url === '/assets/startup-forge/' + name)) return reply.code(404).send({ error: '画像がありません。' });
    try { return reply.type('image/png').header('Cache-Control', 'public, max-age=3600').send(await readFile(path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), 'assets', 'startup-forge', name))); }
    catch { return reply.code(404).send({ error: '画像がありません。' }); }
  });
  app.register(async routes => {
    routes.addHook('preHandler', guard);
    const groups = new AgentGroupStore(workspace);
    const queueHumanReply = (id: string, content: string, group: import('./agent-group.js').AgentGroup) => {
      if (!options.groupRespond || group.federation) return;
      const mentions = parseGroupMentions(content.trim(), group.members);
      const targets = [...new Set(mentions.flatMap(mention => mention.targets).filter(target => target.startsWith('ai:')).map(target => target.slice(3)))];
      const queued = (humanReplyQueues.get(id) || Promise.resolve()).then(async () => {
        if (shutdown.signal.aborted) return;
        await options.groupAutonomy?.humanActivity(id);
        if (mentions.length && !targets.length) return;
        let current = await groups.load(id);
        if (current.discussion?.status === 'running' && current.autonomy?.workflow === 'free') return;
        // 手動の成果作成も追加投稿で協調停止するため、確定保存を待って次の依頼へ進みます。
        const waitUntil = Date.now() + ((current.autonomy?.maxMinutes ?? 20) + 1) * 60000;
        while (current.discussion?.status === 'running') {
          shutdown.signal.throwIfAborted();
          if (Date.now() > waitUntil) throw new Error('直前の成果作成の終了を確認できません。');
          await new Promise(resolve => setTimeout(resolve, 100)); current = await groups.load(id);
        }
        if (current.autonomy?.enabled === false && current.autonomy.updatedAt !== group.autonomy?.updatedAt) return;
        if (current.autonomy?.workflow === 'free') await groups.replyToHuman(id, content, options.groupRespond!, mentions, shutdown.signal);
        else { const result = await groups.outcome(id, content.slice(0,4000), options.groupRespond!, { root: () => options.studyRoot?.(id) || Promise.resolve(undefined), contributors: mentions.length ? targets : undefined, signal: shutdown.signal }); await groups.completeAutonomyCycle(id, result.outcome?.stopReason || 'error'); }
        await options.groupAutonomy?.resumeAfterHuman?.(id);
      }).catch(error => app.log.error({ err: error, groupId: id }, '人間の投稿へのAI返答に失敗しました。'));
      humanReplyQueues.set(id, queued);
      void queued.finally(() => { if (humanReplyQueues.get(id) === queued) humanReplyQueues.delete(id); });
    };
    // 公開入口で許可・訪問者セッションを確認した後だけ呼ぶ内部サービスです。
    options.registerPublicPost?.(async (id, actor, content, profile) => {
      await groups.participate(id, actor, 'join', 'online');
      const group = await groups.post(id, actor.id, content, profile);
      queueHumanReply(id, content, group);
    });
    registerGroupManagementRoutes(routes, groups);
    registerStartupForge(routes, workspace, groups, options.groupRespond, options.studyRoot);
    routes.get('/api/workbench/groups/:id/forge-scene', async req => {
      const id = (req.params as { id: string }).id; await groups.load(id);
      return { scene: await loadForgeScene(workspace, id) || null };
    });
    routes.post('/api/workbench/groups/:id/forge-scene', { bodyLimit: 5_000_000 }, async req => {
      const id = (req.params as { id: string }).id; await groups.load(id);
      return { scene: await saveForgeScene(workspace, id, req.body) };
    });
    registerVisualAssets(routes, workspace, options.groupRespond, undefined, options.imageRuntime);
    const groupModels = async () => [{ id: 'wentian-agent/auto' }, ...await (options.groupModels?.() || Promise.resolve([])), ...await options.models()];
    routes.get('/api/workbench/group-models', async () => ({ models: await groupModels() }));
    routes.get('/api/workbench/groups', async req => {const rows=await groups.list();const allowed=[];for(const group of rows)if(!options.groupKnowledgeAccess||await options.groupKnowledgeAccess(req,group.id))allowed.push(group);return{groups:allowed}});
    routes.post('/api/workbench/groups', async req => {
      const body = req.body as { title: string; names?: string[]; model?: string };
      if (!body || (body.names !== undefined && (!Array.isArray(body.names) || body.names.some(n => typeof n !== 'string')))) throw new Error('参加者名を配列で指定してください。');
      const model = body.model || 'wentian-agent/auto';
      if (!/^wentian-auto\/(local|all|remote)$/.test(model) && !(await groupModels()).some(m => m.id === model)) throw new Error('利用可能なエージェントまたはモデルを選んでください。');
      return groups.create(body.title, body.names?.length ? namedMembers(body.names, model) : await topicMembers(body.title, model, options.groupRespond, await listVisualAssets(workspace)));
    });
    routes.get('/api/workbench/groups/:id', async req => groups.load((req.params as { id: string }).id));
    routes.post('/api/workbench/groups/:id/auto-members', async req => {
      const id = (req.params as { id: string }).id;
      const group = await groups.load(id);
      // 既存のAI参加者がいる場合は追加のLLM判断を行わず、保存済みの構成を維持します。
      if (group.members.some(member => member.kind !== 'human')) return group;
      return groups.ensureMembers(id, await topicMembers(group.title, 'wentian-agent/auto', options.groupRespond, await listVisualAssets(workspace)));
    });
    routes.post('/api/workbench/groups/:id/outcome/export', async req => groups.exportOutcome((req.params as { id: string }).id, await options.studyRoot?.((req.params as { id: string }).id)));
    routes.post('/api/workbench/groups/:id/execution', async req => {
      const settings = req.body as import('./agent-group.js').GroupExecutionSettings;
      if (settings?.mode === 'action' && !options.groupActionRespond) throw new Error('Actionのエージェント実行が未設定です。');
      if (settings?.mode === 'action') delete settings.model;
      return groups.configureExecution((req.params as { id: string }).id, settings);
    });
    routes.post('/api/workbench/groups/:id/autonomy', async req => {
      const body = req.body as { enabled?: boolean; workflow?: 'deliverable' | 'free'; maxRounds?: number; maxMinutes?: number; mode?: 'bounded' | 'continuous'; restSeconds?: number };
      if (!body || typeof body.enabled !== 'boolean') throw new Error('自律討論の有効・無効を指定してください。');
      const id = (req.params as { id: string }).id;
      // 停止操作は進行中の自律討論を先に止めてから無効化します。再開時は停止理由を消して自動実行へ戻します。
      await groups.configureAutonomy(id, { enabled: body.enabled, workflow: body.workflow, maxRounds: body.maxRounds, maxMinutes: body.maxMinutes, mode: body.mode, restSeconds: body.restSeconds, updatedBy: options.groupIdentity?.(req)?.name });
      if (!body.enabled) await options.groupAutonomy?.stop(id);
      return groups.load(id);
    });
    routes.post('/api/workbench/groups/:id/publication', async req => {
      const body = req.body as { published?: boolean; summary?: string; presence?: 'online' | 'offline'; page?: string; participation?: boolean; participationAuth?: 'guest' | 'login' };
      if (body?.participation !== undefined && typeof body.participation !== 'boolean') throw new Error('公開ページからの参加を許可または禁止で指定してください。');
      if (body?.participationAuth !== undefined && !['guest', 'login'].includes(body.participationAuth)) throw new Error('参加認証はguestまたはloginで指定してください。');
      return groups.publish((req.params as { id: string }).id, body?.published!, body?.summary, body?.participation === undefined ? body?.presence : body.participation ? 'online' : 'offline', body?.page ?? '', body?.participationAuth);
    });
    const identity = (req: FastifyRequest) => {
      const actor = options.groupIdentity?.(req);
      if (!actor) throw new Error('会話への参加にはユーザーログインが必要です。');
      return actor;
    };
    routes.post('/api/workbench/groups/:id/moderation', async (req, reply) => {
      const actor = identity(req);
      if (!actor.admin) return reply.code(403).send({ error: { message: '管理者だけが参加者を管理できます。' } });
      const body = req.body as { userId?: string; action?: string };
      if (body?.userId === actor.id) throw new Error('自分自身への管理操作はできません。');
      return groups.moderate((req.params as { id: string }).id, body?.userId!, body?.action!, actor.id);
    });
    for (const action of ['join', 'leave', 'presence'] as const) routes.post('/api/workbench/groups/:id/' + action, async req => {
      const actor = identity(req), body = req.body as { presence?: 'online' | 'offline' } | undefined;
      return groups.participate((req.params as { id: string }).id, actor, action, body?.presence ?? 'online');
    });
    routes.post('/api/workbench/groups/:id/messages', async req => {
      const body = req.body as { content?: string; nickname?: string };
      // クライアント送信のIP・利用者IDは採用せず、認証済み本人と実際の接続元を使います。
      const id = (req.params as { id: string }).id;
      const group = await groups.post(id, identity(req).id, body?.content!, { nickname: body?.nickname, ipAddress: req.ip });
      queueHumanReply(id, body.content!, group);
      return group;
    });
    routes.post('/api/workbench/groups/:id/avatar', { bodyLimit: 200000 }, async req => {
      const actor = identity(req), body = req.body as { name?: string; avatar?: GroupAvatar };
      if (!body || typeof body.name !== 'string' || !body.avatar) throw new Error('メンバーと画像を指定してください。');
      return groups.avatar((req.params as { id: string }).id, body.name, body.avatar, actor.admin ? undefined : actor.id);
    });
    routes.post('/api/workbench/groups/:id/members/:action', async req => {
      const { id, action } = req.params as { id: string; action: string };
      if (!['add', 'update', 'remove'].includes(action)) throw new Error('不正なメンバー操作です。');
      const body = req.body as { name: string; member?: { name: string; role: string; model: string } };
      if (!body || typeof body.name !== 'string') throw new Error('メンバー名を指定してください。');
      if (action !== 'remove') {
        const model = body.member?.model;
        if (typeof model !== 'string' || (!/^wentian-auto\/(local|all|remote)$/.test(model) && !(await groupModels()).some(m => m.id === model))) throw new Error('利用可能なエージェントまたはモデルを選んでください。');
      }
      return groups.member(id, action as 'add' | 'update' | 'remove', body.name, body.member);
    });
    routes.post('/api/workbench/groups/:id/discuss', async req => {
      if (!options.groupRespond) throw new Error('グループのモデル接続が未設定です。');
      const body = req.body as { prompt: string; rounds?: number; participants?: string[]; untilConsensus?: boolean; maxRounds?: number; maxMinutes?: number };
      const id = (req.params as { id: string }).id;
      // 実行開始時の保存済み設定を使います。利用者が送った履歴から操作権限を取得しません。
      if ((await groups.load(id)).autonomy?.workflow !== 'free') return groups.outcome(id, body?.prompt, options.groupRespond, { maxRounds: body?.maxRounds, maxMinutes: body?.maxMinutes, root: () => options.studyRoot?.(id) || Promise.resolve(undefined), contributors: body?.participants });
      return groups.discuss(id, body?.prompt, body?.rounds ?? 1, async (member, messages, context, signal) => {
        const execution = (await groups.load(id)).execution;
        if (execution?.mode === 'action' && !context?.phase) {
          if (!options.groupActionRespond) throw new Error('Action実行が未設定です。');
          return options.groupActionRespond(member, messages, execution, signal);
        }
        return options.groupRespond!(member, messages, context, signal);
      }, body?.participants, { untilConsensus: body?.untilConsensus, maxRounds: body?.maxRounds, maxMinutes: body?.maxMinutes, requester: options.groupIdentity?.(req) });
    });
    routes.setErrorHandler((error, _req, reply) => reply.code((error as { statusCode?: number }).statusCode === 403 ? 403 : 400).send({ error: { message: error instanceof Error ? error.message : '操作に失敗しました。' } }));
    routes.get('/api/workbench', async () => {
      const goals = await listGoals(), sessions = await listAgentSessions();
      return { version: '0.6.0', workspace,
        goals: await Promise.all(goals.filter(belongs).map(async goal => ({ ...goal, running: await active(goal.id) }))),
        sessions: sessions.filter(session => path.resolve(session.workspace) === workspace).slice(0, 20).map(({ id, title, model, usage, updatedAt }) => ({ id, title, model, usage, updatedAt })),
        skills: await listSkills(workspace),
      };
    });
    routes.get('/api/workbench/models', async () => ({ models: await options.models() }));
    routes.post('/api/workbench/connection', async req => mutate('connection', async () => {
      const body = req.body as { baseUrl: string; apiKey?: string; scope: 'local' | 'remote' };
      if (!body || !['local', 'remote'].includes(body.scope)) throw new Error('接続先の種類を選んでください。');
      const provider = await (options.saveProvider || saveOnboardingProvider)({ baseUrl: body.baseUrl, apiKey: body.apiKey, scope: body.scope });
      options.providerSaved(provider); return { saved: true };
    }));
    routes.post('/api/workbench/test-model', async req => {
      const model = (req.body as { model?: string })?.model;
      if (!model || !(await options.models()).some(item => item.id === model)) throw new Error('利用可能なモデルを選んでください。');
      return { response: await options.testModel(model) };
    });
    routes.get('/api/workbench/skills/:name', async req => loadSkillPresentation((req.params as { name: string }).name, workspace));
    routes.post('/api/workbench/goals', async req => {
      const body = req.body as { title?: string; description?: string; acceptance?: unknown };
      if (!body || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200 || typeof body.description !== 'string' || body.description.length > 20_000) throw new Error('タイトルと依頼内容を入力してください。');
      const acceptance = validateAcceptance(body.acceptance || []);
      const goal = await createGoal({ title: body.title.trim(), description: body.description, workspace, executionMode: 'internal' });
      await addTodo(goal, { title: body.title.trim(), description: body.description, acceptance });
      goal.status = 'paused'; await saveGoal(goal); return goal;
    });
    routes.post('/api/workbench/goals/bulk-delete', async req => mutate('goals', async () => {
      const ids = (req.body as { ids?: unknown })?.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string')) throw new Error('削除するタスクを1〜1000件選択してください。');
      const uniqueIds = [...new Set(ids as string[])];
      // 削除開始前に全件の所属・存在・停止を確認し、不正な混在要求では1件も変更しません。
      for (const id of uniqueIds) { await get(id); await idle(id); }
      const deleted: string[] = [], failed: Array<{ id: string; message: string }> = [];
      for (const id of uniqueIds) {
        try { await idle(id); await deleteGoal(id); deleted.push(id); }
        catch (error) { failed.push({ id, message: error instanceof Error ? error.message : '削除に失敗しました。' }); }
      }
      return { deleted, failed };
    }));
    routes.post('/api/workbench/goals/:id/:action', async req => {
      const { id, action } = req.params as { id: string; action: string };
      return mutate('goals', async () => {
        const goal = await get(id);
        if (action === 'pause') { await requestGoalPause(id); return { message: '現在のステップが終わると一時停止します。' }; }
        await idle(id);
        if (action === 'delete') {
          // 既存の認証・ワークスペース境界・操作ロックを通過した停止済みタスクだけを削除します。
          await deleteGoal(id);
          return { deleted: true, id };
        }
        if (action === 'run') {
          for (const other of (await listGoals()).filter(belongs)) {
            if (await active(other.id)) throw new Error('この作業場所では別のタスクが実行中です。完了または一時停止を待ってください。');
          }
          if (goal.status === 'completed') throw new Error('完了済みです。新しいタスクを作成してください。');
          if (goal.todos.some(todo => todo.status === 'blocked')) throw new Error('検証待ちの項目を再検証するか、修正して再開してください。');
          const body = req.body as { model?: string };
          const model = body?.model || 'wentian-auto/local';
          if (!/^wentian-auto\/(local|all|remote)$/.test(model) && !(await options.models()).some(item => item.id === model)) throw new Error('利用できないモデルです。');
          await consumeGoalPause(id);
          const address = app.server.address();
          const port = typeof address === 'object' && address ? address.port : 8787;
          return await (options.start || startGoalDaemon)({ goalId: id, cwd: workspace, server: `http://127.0.0.1:${port}`, model });
        }
        if (action === 'revise') {
          const body = req.body as { instruction?: string; acceptance?: unknown };
          if (!body || typeof body.instruction !== 'string' || !body.instruction.trim() || body.instruction.length > 10_000) throw new Error('追加指示を入力してください。');
          if (goal.status === 'completed') throw new Error('完了済みのタスクは変更できません。');
          const acceptance = body.acceptance === undefined ? undefined : validateAcceptance(body.acceptance);
          goal.description += `\n追加指示: ${body.instruction}`;
          for (const todo of goal.todos.filter(todo => todo.status !== 'done')) {
            todo.description = `${todo.description || ''}\n${body.instruction}`;
            if (acceptance) todo.acceptance = acceptance;
            todo.status = 'pending'; todo.verification = undefined; todo.lastError = null;
          }
          goal.blocked = []; goal.metrics.blockedCount = 0; goal.metrics.consecutiveFailures = 0; goal.status = 'paused';
          await saveGoal(goal); return goal;
        }
        if (action === 'verify') {
          for (const todo of goal.todos.filter(todo => todo.status === 'blocked')) {
            todo.verification = await verifyDelivery(workspace, todo.acceptance || []);
            if (todo.verification.status === 'passed') { todo.status = 'done'; todo.completedAt = new Date().toISOString(); todo.lastError = null; }
          }
          goal.blocked = goal.blocked.filter(item => goal.todos.find(todo => todo.id === item.todoId)?.status === 'blocked');
          goal.metrics.blockedCount = goal.blocked.length; goal.metrics.completedCount = goal.todos.filter(todo => todo.status === 'done').length;
          if (goal.todos.length && goal.todos.every(todo => todo.status === 'done')) goal.status = 'completed';
          await saveGoal(goal); return goal;
        }
        throw new Error('未対応の操作です。');
      });
    });
    routes.get('/api/workbench/goals/:id/log', async req => {
      const { id } = req.params as { id: string }; await get(id);
      const record = await readDaemonRecord(id);
      if (!record) return { text: 'まだ実行されていません。' };
      // ログ全体をメモリに載せず、固定された保存先の末尾だけを返します。
      const handle = await open(path.join(path.dirname(goalPath(id)), id, 'daemon.log'), 'r');
      try { const size = (await handle.stat()).size; const buffer = Buffer.alloc(Math.min(size, 24_000)); await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length)); return { text: buffer.toString('utf8') }; }
      finally { await handle.close(); }
    });
  });
}
