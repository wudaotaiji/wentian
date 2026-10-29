import path from 'node:path';
import { lstat, readFile, readdir } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { listGoals } from './goal-store.js';
import { redactTrainingText } from './training-data.js';
import { WorkflowStore } from './parallel-workflow.js';
import { assertOrdinaryPath } from './safe-file.js';
import { withCenterShell } from './center-shell.js';
import { isPidAlive, readDaemonRecord } from './goal-daemon.js';

/** 実行台帳の公開投影です。依頼本文・コマンド・認証値・作業場所の絶対パスは含めません。 */
export interface OperationSummary {
  kind?: 'execution' | 'workflow';
  id: string; status: string; agents: string[]; models: string[]; stage: string;
  reason: string; changes: Array<{ path: string; kind: string }>;
  verification: string; updatedAt?: string; nextAction: string;
}

/** 作業状況の絞り込みと詳細は取得済みの公開データを描画し、更新失敗時は前回値と失敗を区別します。 */
export const operationsHtml = withCenterShell(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wentian 作業状況</title></head><body><main>
<div class="toolbar"><button id="refresh" class="primary">更新</button><label><input id="autoRefresh" type="checkbox" checked> 自動更新</label><span id="updated" class="muted">未取得</span></div><p id="notice" role="status" aria-live="polite"></p>
<div id="summary" class="cards"></div><section><div class="toolbar"><label>作業を検索<input id="search" type="search" placeholder="名前・担当・モデル・停止理由"></label><label>状態<select id="filter"><option value="">すべて</option><option value="running">実行中</option><option value="waiting">実行待ち・停止中</option><option value="attention">要確認</option><option value="done">完了</option></select></label><span id="matches" class="muted"></span></div><div id="tasks" class="table-scroll"></div></section>
<section id="detailPanel" hidden><h2 id="detailTitle"></h2><div id="detail"></div></section></main>
<script>
(()=>{const $=id=>document.getElementById(id);let data,selected='',loading=false;
const names={running:'実行中',stopping:'停止処理中',active:'実行待ち',paused:'一時停止',draft:'準備中',completed:'完了',success:'成功',failed:'失敗',blocked:'要確認',aborted:'中止',pending:'待機',done:'完了',passed:'合格',not_configured:'条件未設定',unknown:'未確認'};
const label=value=>names[value]||value||'未記録';const text=(tag,value)=>{const el=document.createElement(tag);el.textContent=value;return el};
const rows=()=>[...(data?.operations||[]).map(x=>({...x,title:x.id})),...(data?.goals||[]).map(g=>({...g,kind:'goal',status:g.running?'running':g.status,agents:g.todos.map(t=>t.owner),models:[],stage:g.todos.filter(t=>t.status==='done').length+'/'+g.todos.length+'工程完了',reason:g.todos.map(t=>t.reason).filter(Boolean).join(' / '),changes:[],verification:g.todos.some(t=>t.verification==='failed')?'failed':g.todos.every(t=>t.verification==='passed')&&g.todos.length?'passed':'pending'}))];
const category=row=>['completed','success','done'].includes(row.status)?'done':['failed','blocked','aborted'].includes(row.status)||row.verification==='failed'?'attention':['running','stopping'].includes(row.status)?'running':'waiting';
function render(){if(!data)return;const all=rows();$('summary').replaceChildren();for(const [title,items]of [['作業総数',all],['実行中',all.filter(x=>category(x)==='running')],['要確認',all.filter(x=>category(x)==='attention')],['完了',all.filter(x=>category(x)==='done')]]){const card=text('div',title);card.className='card';card.prepend(text('strong',String(items.length)));$('summary').append(card)}const query=$('search').value.trim().toLowerCase(),state=$('filter').value;const visible=all.filter(x=>(!state||category(x)===state)&&[x.title,x.id,...x.agents,...x.models,x.reason].join(' ').toLowerCase().includes(query));$('matches').textContent=visible.length+' / '+all.length+' 件';$('tasks').replaceChildren();if(!visible.length){const empty=text('p',all.length?'条件に一致する作業がありません。':'作業はまだありません。工作台でタスクを作成してください。');empty.className='empty';$('tasks').append(empty)}else{const table=document.createElement('table'),head=table.createTHead().insertRow();for(const title of ['作業','状態・進捗','担当・モデル','検証','更新','操作'])head.append(text('th',title));for(const row of visible){const tr=table.insertRow();tr.append(text('td',row.title),text('td',label(row.status)+' / '+row.stage),text('td',[...new Set(row.agents),...new Set(row.models)].join(' / ')||'未記録'),text('td',label(row.verification)),text('td',row.updatedAt?new Date(row.updatedAt).toLocaleString():'未記録'));const actions=document.createElement('td'),b=text('button','詳細');b.onclick=()=>{selected=row.id;renderDetail()};const a=text('a',row.kind==='goal'?'タスクを開く':row.kind==='workflow'?'並列工程を開く':'工作台を開く');a.href=row.kind==='workflow'?'/workflows#'+encodeURIComponent(row.id):'/workbench#tasks';actions.append(b,a);tr.append(actions)}$('tasks').append(table)}renderDetail()}
function renderDetail(){const row=rows().find(x=>x.id===selected);$('detailPanel').hidden=!row;if(!row)return;$('detailTitle').textContent=row.title;$('detail').replaceChildren();for(const [title,value]of [['状態',label(row.status)],['工程',row.stage],['停止理由',row.reason||'停止理由はありません'],['検証',label(row.verification)],['次の操作',row.nextAction]])$('detail').append(text('p',title+': '+value));const changes=text('pre',row.changes.map(c=>c.kind+': '+c.path).join('\\n')||'ファイル差分はありません');$('detail').append(changes);if(row.todos)for(const todo of row.todos)$('detail').append(text('p',todo.title+' / '+label(todo.status)+' / '+label(todo.verification)+(todo.reason?' / '+todo.reason:'')))}
async function refresh(){if(loading)return;loading=true;$('refresh').disabled=true;try{const r=await fetch('/api/workbench/operations');if(!r.ok)throw Error('作業状況を取得できません。ログインと権限を確認してください。');data=await r.json();$('notice').textContent=(data.warnings||[]).join(' ');$('updated').textContent='最終更新: '+new Date().toLocaleTimeString();render()}catch(e){$('notice').textContent=e.message+(data?' 前回取得した情報を表示しています。':'')}finally{loading=false;$('refresh').disabled=false}}
$('search').oninput=render;$('filter').onchange=render;$('refresh').onclick=refresh;refresh();setInterval(()=>{if($('autoRefresh').checked&&!document.hidden)refresh()},10000);
})();
</script></body></html>`, 'operations', '作業状況', '作業の進捗、停止理由、検証結果をまとめて確認。');
const text = (value: unknown) => typeof value === 'string' ? redactTrainingText(value).slice(0, 500) : '';

/** バージョンの異なる直接実行・外部委任の台帳を、同じ表示形式へ変換します。 */
export function summarizeOperation(value: any): OperationSummary {
  const task = value?.task || {}, result = value?.result || {}, outcome = result.outcome || {};
  const status = text(result.state || outcome.status || result.status || 'unknown');
  const reports = Array.isArray(result.reports) ? result.reports : [];
  const verification = text(result.acceptance?.status || result.delivery?.status || 'not_configured');
  const changes = Array.isArray(result.evidence?.changes) ? result.evidence.changes : [];
  return {
    kind: 'execution',
    id: text(task.taskId || result.taskId), status,
    agents: [...(Array.isArray(result.selectedAgents) ? result.selectedAgents : []), task.agent].map(text).filter(Boolean),
    models: [...new Set<string>([task.model, ...reports.map((r: any) => r.model || r.resolvedModel)].map(text).filter(Boolean))],
    stage: text(result.stage || result.publication?.status || result.acceptance?.status || reports.at(-1)?.role || '計画・実行結果'),
    reason: text(outcome.reason || result.note),
    changes: changes.slice(0, 100).map((c: any) => ({ path: text(c.path), kind: text(c.kind) })),
    verification, updatedAt: text(value.updatedAt || result.acceptance?.finishedAt) || undefined,
    nextAction: ['success', 'completed'].includes(status) ? '成果と検証結果を確認' :
      status === 'running' ? '進捗を確認・必要なら一時停止' : '停止理由と許可範囲を確認して再実行',
  };
}

/** 固定された作業場所内の通常ファイルだけを読みます。リンクによる台帳のすり替えは拒否します。 */
export async function listOperations(workspace: string): Promise<{ operations: OperationSummary[]; warnings: string[] }> {
  const root = path.resolve(workspace, '.wentian/orchestration/runs');
  const warnings: string[] = [], operations: OperationSummary[] = [];
  let names: string[];
  try {
    // 中間ディレクトリーのリンクも拒否し、作業場所外の状態を管理画面へ持ち込みません。
    for (const name of ['.wentian', '.wentian/orchestration', '.wentian/orchestration/runs']) {
      if ((await lstat(path.resolve(workspace, name))).isSymbolicLink()) throw new Error('リンクされた台帳は読めません。');
    }
    names = (await readdir(root)).sort().reverse().slice(0, 100);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { operations, warnings };
    return { operations, warnings: ['実行台帳の読取りに失敗しました。'] };
  }
  for (const name of names) {
    try {
      const directory = path.join(root, name), target = path.join(directory, 'manifest.json');
      await assertOrdinaryPath(target);
      const dirInfo = await lstat(directory), info = await lstat(target);
      if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory() || info.isSymbolicLink() || !info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('不正な台帳');
      operations.push(summarizeOperation(JSON.parse(await readFile(target, 'utf8'))));
    } catch { warnings.push('一部の実行台帳を読めません。'); }
  }
  return { operations, warnings: [...new Set(warnings)] };
}

/** 担当・モデル・工程・停止理由・差分・検証・次の操作を一つの画面にまとめます。 */
export function registerOperationsCenter(app: FastifyInstance, options: {
  workspace: string; workflowRoot?: string; model?: string; authorize: (req: FastifyRequest, reply: FastifyReply) => boolean;
}): void {
  app.get('/api/workbench/operations', async (req, reply) => {
    if (!options.authorize(req, reply)) return reply;
    const manifests = await listOperations(options.workspace);
    const workflows = await new WorkflowStore(options.workflowRoot || path.join(options.workspace, '.wentian', 'workflows')).list();
    for (const item of workflows) {
      if (!item.state) { manifests.warnings.push('並列工程の台帳を読み取れません。'); continue; }
      const workflow = item.state;
      manifests.operations.push({ kind: 'workflow', id: text(workflow.id), status: text(workflow.status), agents: workflow.nodes.map(node => text(node.id)), models: options.model ? [text(options.model)] : [],
        stage: workflow.nodes.map(node => `${text(node.id)}: ${text(node.status)}`).join(', '), reason: workflow.nodes.filter(node => node.error).map(node => text(node.error)).join(', '),
        changes: workflow.nodes.flatMap(node => (node.changes || []).map(change => ({ path: text(change.path), kind: text(change.kind) }))), verification: text(workflow.merge?.status || 'pending'),
        updatedAt: text(workflow.updatedAt), nextAction: workflow.status === 'completed' ? '成果を確認' : '並列工程画面で停止理由を確認・失敗工程を再試行' });
    }
    const goals = (await listGoals()).filter(g => path.resolve(g.workspace || options.workspace) === path.resolve(options.workspace));
    return { ...manifests, goals: await Promise.all(goals.map(async g => { const record = await readDaemonRecord(g.id); return ({ id: g.id, title: text(g.title), status: g.status, running: Boolean(record && record.status !== 'dead' && await isPidAlive(record.pid)), updatedAt: g.updatedAt,
      todos: g.todos.map(t => ({ id: t.id, title: text(t.title), status: t.status, owner: t.owner,
        dependencies: t.dependsOn, reason: text(t.lastError), verification: t.verification?.status || 'pending' })),
      nextAction: g.status === 'paused' ? '工作台で再開' : '工作台で工程と受入条件を確認',
    }); })) };
  });
  app.get('/operations', async (req, reply) => {
    if (!options.authorize(req, reply)) return reply;
    return reply.type('text/html; charset=utf-8').send(operationsHtml);
  });
}
