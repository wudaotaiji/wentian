/**
 * 並列工程編集画面（Workflow Center / Parallel Workflow Editor UI）
 *
 * 目的: 既存の並列作業API（Parallel Workflow API: src/parallel-workflow-routes.ts）を
 * ブラウザーから編集・実行・観測できる日本語UI（User Interface）を1ファイルで提供する。
 *
 * 接続する実API（Real Endpointsのみ / 新規APIは追加しない）:
 * - GET  /api/workbench/workflows            … 一覧（状態・差分・履歴を含む公開ビュー）
 * - POST /api/workbench/workflows            … 作成（nodes / acceptanceChecks / maxConcurrency）
 * - POST /api/workbench/workflows/:id/run    … 初回実行（draftのみ）
 * - POST /api/workbench/workflows/:id/retry  … 失敗・blockedだけ部分再実行（Partial Re-run）
 *
 * 安全設計（Safety Constraints）:
 * - 画面は実行コマンドやコードを一切受け取らない。送信するのは構造化プラン（Structured Plan）
 *   ・固定受入条件（Fixed Acceptance Checks）・並列数（Concurrency）だけ。
 * - 用户入力・API応答はすべて textContent で描画（HTML injection 回避）。
 * - キー・秘密情報（Secrets）は保存しない（表示設定だけを保存）。
 * - 権限（Authorization）はホストから注入された authorize をそのまま使用し、画面自身の
 *   判定ロジックは持たない。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { withCenterShell } from './center-shell.js';

/** プラン初期値（Initial Plan Template）。実行可能な最小構成の例で、コマンドは含まない。 */
const PLAN_TEMPLATE = JSON.stringify([
  { id: 'docs', dependencies: [], inputs: ['README.md'], allowedWritePaths: ['docs/notes.md'], acceptance: '要約ファイルを作成する', sideEffect: false },
], null, 2);

/** 固定受入条件の初期値（Fixed Acceptance Template）。存在と包含文字列だけを検査する。 */
const CHECKS_TEMPLATE = JSON.stringify([{ path: 'docs/notes.md', contains: '要約' }], null, 2);

/** GET /workflows で配信する日本語画面（Standalone: 外部CDN・依存ライブラリなし）。 */
export const workflowCenterHtml = withCenterShell(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wentian · 並列工程センター（Workflow Center）</title>
<style>
:root{color-scheme:dark;--bg:#0b1018;--panel:#131c28;--line:#273344;--text:#edf2fa;--muted:#96a6bb;--accent:#8ba9ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 system-ui,sans-serif}
header{padding:16px 26px;border-bottom:1px solid var(--line)}h1{margin:0;font-size:21px}h2{font-size:17px;margin:0}
main{max-width:1320px;margin:auto;padding:22px}section{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:minmax(300px,1fr) minmax(360px,1.4fr);gap:16px}
label{display:block;margin:8px 0}input,textarea,button,select{font:inherit;border:1px solid var(--line);border-radius:9px;background:#0c1420;color:var(--text);padding:9px 11px}
textarea{width:100%;min-height:150px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
input{width:120px}button{cursor:pointer;margin:3px 6px 3px 0}button.primary{background:var(--accent);color:#10192c;border:0;font-weight:700}
button:disabled{opacity:.45;cursor:not-allowed}button[aria-pressed=true]{border-color:var(--accent);color:#afc2ff}
button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
#notice{min-height:26px;color:#f6cb75;white-space:pre-wrap;overflow-wrap:anywhere}
.workflow{display:block;width:100%;text-align:left;margin-bottom:7px;padding:11px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:7px;text-align:left;vertical-align:top}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0c1420;padding:11px;border-radius:9px;max-height:260px;overflow:auto}
.muted,small{color:var(--muted)}.hidden,[hidden]{display:none!important}code{background:#0c1420;padding:1px 5px;border-radius:5px}
</style></head><body>
<header><h1>Wentian <span class="muted">並列工程センター（Workflow Center）</span></h1>
<small>共通基準（Common Baseline）からの隔離実行（Isolated Run）・固定受入検証（Fixed Verification）・失敗だけの再試行（Partial Re-run）</small></header>
<main><div id="notice" role="status" aria-live="polite"></div>
<div id="workflowSummary" class="cards"></div>
<div class="grid"><div>
<section><h2>1 · 工程プラン（Workflow Plan）</h2>
<p class="muted">工程をフォームで追加し、依存関係と成果物を確認して作成します。</p>
<label>工程ID<input id="nodeId" placeholder="review"></label><label>依存する工程ID（カンマ区切り）<input id="nodeDependencies" placeholder="docs"></label><label>読み取る相対パス（1行に1件）<textarea id="nodeInputs"></textarea></label><label>書き込む相対パス（1行に1件）<textarea id="nodeWrites" placeholder="docs/review.md"></textarea></label><label>この工程への依頼<textarea id="nodeAcceptance" placeholder="資料を確認してレビューを作成"></textarea></label><button id="addNode">工程を追加</button><button id="previewPlan">計画を確認</button><div id="planPreview"></div>
<details><summary>詳細なJSON編集</summary>
<label>工程ノードJSON（nodes）<textarea id="plan" spellcheck="false"></textarea></label>
<label>固定受入条件JSON（acceptanceChecks）<textarea id="checks" spellcheck="false"></textarea></label>
</details><label>成果物の相対パス<input id="checkPath" placeholder="docs/notes.md"></label><label>成果物に必要な文字列<input id="checkContains" placeholder="要約"></label><button id="addCheck">検証条件を追加</button><div id="checkPreview"></div>
<label>並列数（maxConcurrency / 1〜8）<input id="concurrency" type="number" min="1" max="8" value="2"></label>
<button id="create" class="primary">ワークフローを作成</button>
<small>書込み範囲（allowedWritePaths）の重なり、循環依存（Cycle）、コマンド指定はサーバー側で拒否されます。</small></section>
<section><h2>2 · 一覧（Workflows）</h2>
<button id="refresh" class="primary">更新</button>
<label>工程を検索<input id="workflowSearch" type="search" placeholder="工程ID・状態"></label><label>状態<select id="workflowFilter" data-ui-options><option value="">すべて</option><option value="draft">準備中</option><option value="running">実行中</option><option value="failed">失敗</option><option value="blocked">要確認</option><option value="completed">完了</option></select></label><label><input id="workflowAuto" type="checkbox" checked> 自動更新</label><span id="workflowUpdated" class="muted"></span>
<div id="list"><p class="muted">まだ読み込んでいません。「更新」を押してください。</p></div></section>
</div><div>
<section><h2 id="detailTitle">3 · 工程状態・差分（Node Status &amp; Diff）</h2>
<p class="muted" id="detailHint">一覧からワークフローを選択してください。</p>
<div id="detail" hidden>
<p id="detailMeta" class="muted"></p>
<progress id="workflowProgress" max="100" value="0" aria-label="工程の進捗"></progress><p id="progressLabel" class="muted"></p><div id="dependencyView"></div>
<div class="toolbar" style="display:flex;flex-wrap:wrap">
<button id="run" class="primary">初回実行（run）</button>
<button id="retry">失敗だけ再試行（retry）</button>
<button id="detailRefresh">この台帳を再読込</button></div>
<h3>ノード</h3><div class="table-scroll"><table><thead><tr><th>ID</th><th>状態</th><th>試行</th><th>書込み範囲</th><th>差分（Diff）</th><th>失敗理由</th></tr></thead><tbody id="nodes"></tbody></table></div>
<h3>統合・反映（Integration / Publish）</h3><pre id="merge">未取得</pre>
<h3>履歴（History / 直近20件）</h3><pre id="history">未取得</pre>
<small>表示するのは公開ビュー（Sanitized View）だけです。絶対Path・作業場所・基準SHAは配信されません。</small>
</div></section>
</div></div></main>
<script>
(()=>{'use strict';
var $=function(id){return document.getElementById(id)};
function message(el,key,params){window.wentianUi.message(el,key,params)}
function stateLabel(state){return {uiKey:({draft:'下書き',pending:'待機中',running:'実行中',success:'成功',failed:'失敗',blocked:'要確認',completed:'完了'})[state]||state||'不明'}}
var PLAN=${JSON.stringify(PLAN_TEMPLATE)},CHECKS=${JSON.stringify(CHECKS_TEMPLATE)};
var workflows=[],selected=decodeURIComponent(location.hash.slice(1)),busy=false,refreshing=false;
function notice(text){$('notice').removeAttribute('data-ui-message');$('notice').removeAttribute('data-ui-params');$('notice').textContent=String(text||'')}
function text(tag,content){var node=document.createElement(tag);node.textContent=String(content);return node}
/** 実APIだけを描画する。応答の error は文字列 / {message} 両方に対応する。 */
async function api(url,body,emptyPost){
  var init={method:body!==undefined?'POST':(emptyPost?'POST':'GET'),headers:{}};
  if(body!==undefined){init.headers['content-type']='application/json';init.body=JSON.stringify(body)}
  var response=await fetch(url,init);
  var data=null;try{data=await response.json()}catch(error){/* JSONでない応答は本文なしとして扱う */}
  if(response.status<200||response.status>=300){
    var message=data&&typeof data.error==='string'?data.error:(data&&data.error&&data.error.message)||'';
    throw new Error((message||'要求を拒否されました')+'（HTTP '+response.status+'）');
  }
  return data;
}
async function perform(target,action){
  if(busy)return;busy=true;
  target.disabled=true;notice('');
  try{await action()}catch(error){notice(error&&error.message?error.message:'操作に失敗しました。')}
  finally{busy=false;target.disabled=false;renderDetail()}
}
function statusCell(node){var cell=text('td','');message(cell,'{state}{reuse}{sideEffect}',{state:stateLabel(node.status),reuse:node.reusedByHash?{uiKey:'（ハッシュ再利用）'}:'',sideEffect:node.reusedSideEffect?{uiKey:'（副作用を保護）'}:''});return cell}
function selectedWorkflow(){return workflows.find(function(item){return item.id===selected})}
function renderDetail(){
  var view=selectedWorkflow();
  if(!view){$('detail').hidden=true;$('detailHint').hidden=false;$('detailHint').textContent='一覧からワークフローを選択してください。';return}
  $('detailHint').hidden=true;$('detail').hidden=false;
  $('detailTitle').textContent='3 · '+view.id;
  message($('detailMeta'),'状態: {state} / 並列数: {concurrency} / 更新: {updated}',{state:stateLabel(view.status),concurrency:view.maxConcurrency,updated:view.updatedAt||{uiKey:'不明'}});
  $('run').disabled=busy||view.status!=='draft';
  $('retry').disabled=busy||view.status==='running'||view.status==='draft'||view.status==='completed';
  var complete=(view.nodes||[]).filter(node=>node.status==='success').length,total=(view.nodes||[]).length;
  $('workflowProgress').value=total?100*complete/total:0;message($('progressLabel'),'{complete} / {total} 工程完了',{complete:complete,total:total});$('dependencyView').replaceChildren();for(var node of view.nodes||[]){var card=text('div','');message(card,'{id} ← {dependencies}',{id:node.id,dependencies:(node.dependencies||[]).join(', ')||{uiKey:'開始工程'}});card.className='node-card';$('dependencyView').append(card)}
  var tbody=$('nodes');tbody.replaceChildren();
  for(var node of (view.nodes||[])){
    var row=document.createElement('tr');
    row.append(text('td',node.id),statusCell(node),text('td',node.attempts),
      text('td',(node.allowedWritePaths||[]).join(', ')||'なし'),
      text('td',(node.changes||[]).map(function(change){return change.kind+' '+change.path+(change.afterHash?' ['+change.afterHash.slice(0,8)+']':'')}).join('\\n')||'差分なし'),
      text('td',node.error||''));
    tbody.append(row);
  }
  $('merge').textContent=view.merge?('統合: '+view.merge.status+'\\n'+(view.merge.note||'')+'\\n対象ファイル: '+(view.merge.files||[]).join(', ')):'統合まだ';
  $('history').textContent=(view.history||[]).map(function(item){return item.at+' · '+item.event+(item.nodeId?' ['+item.nodeId+']':'')+' · '+(item.note||'')}).join('\\n')||'履歴なし';
}
function renderList(){
  $('workflowSummary').replaceChildren();for(var entry of [['工程一覧',workflows.length],['実行中',workflows.filter(x=>x.status==='running').length],['要確認',workflows.filter(x=>['failed','blocked'].includes(x.status)).length],['完了',workflows.filter(x=>x.status==='completed').length]]){var card=text('div',entry[0]);card.className='card';card.prepend(text('strong',String(entry[1])));$('workflowSummary').append(card)}
  var box=$('list');box.replaceChildren();
  if(!workflows.length){box.append(text('p','ワークフローはまだありません。'));return}
  for(var view of workflows){
    if($('workflowFilter').value&&view.status!==$('workflowFilter').value)continue;
    if(!(view.id+' '+view.status).toLowerCase().includes($('workflowSearch').value.toLowerCase()))continue;
    var button=document.createElement('button');button.className='workflow';
    message(button,'{id} · {state} · ノード{count}件 · {updated}',{id:view.id,state:stateLabel(view.status),count:(view.nodes||[]).length,updated:view.updatedAt||''});
    button.setAttribute('aria-pressed',String(view.id===selected));
    button.onclick=function(id){return function(){selected=id;renderList();renderDetail()}}(view.id);
    box.append(button);
  }
  if(!box.children.length)box.append(text('p','条件に一致する工程がありません。'));
}
async function refreshList(preferredId){
  if(refreshing)return;refreshing=true;try{
  var data=await api('/api/workbench/workflows');
  workflows=(data&&data.workflows)||[];
  var wanted=preferredId||selected;
  if(!workflows.some(function(item){return item.id===wanted}))selected=workflows.length?workflows[0].id:'';
  else selected=wanted;
  renderList();renderDetail();
  message($('workflowUpdated'),'最終更新: {time}',{time:new Date().toLocaleTimeString()});
  }finally{refreshing=false}
}
$('plan').value=PLAN;$('checks').value=CHECKS;
$('create').onclick=function(){perform($('create'),async function(){
  var nodes=JSON.parse($('plan').value),checks=JSON.parse($('checks').value),concurrency=Number($('concurrency').value);
  var created=await api('/api/workbench/workflows',{nodes:nodes,acceptanceChecks:checks,maxConcurrency:concurrency});
  message($('notice'),'作成しました: {id}（初回実行はdraft時のみ可能です）',{id:created.id});
  await refreshList(created.id);
})};
$('refresh').onclick=function(){perform($('refresh'),async function(){await refreshList();notice('一覧を更新しました。')})};
$('detailRefresh').onclick=function(){perform($('detailRefresh'),async function(){await refreshList();notice('台帳を再読込しました。')})};
$('run').onclick=function(){perform($('run'),async function(){
  var id=selected;var view=await api('/api/workbench/workflows/'+encodeURIComponent(id)+'/run',undefined,true);
  message($('notice'),'初回実行が終了しました: {state}',{state:view&&view.status});await refreshList(id);
})};
$('retry').onclick=function(){perform($('retry'),async function(){
  var id=selected;var view=await api('/api/workbench/workflows/'+encodeURIComponent(id)+'/retry',undefined,true);
  message($('notice'),'再試行が終了しました: {state}',{state:view&&view.status});await refreshList(id);
})};
function preview(){var nodes=JSON.parse($('plan').value),checks=JSON.parse($('checks').value);if(!Array.isArray(nodes)||!Array.isArray(checks))throw Error('工程と検証条件は配列で入力してください。');$('planPreview').replaceChildren();nodes.forEach(function(node,index){var card=text('div',''),label=text('span','');message(label,'{id} ← {dependencies} / 成果物: {outputs}',{id:node.id,dependencies:(node.dependencies||[]).join(', ')||{uiKey:'開始工程'},outputs:(node.allowedWritePaths||[]).join(', ')});card.append(label);card.className='node-card';var remove=text('button','工程を外す');remove.onclick=function(){nodes.splice(index,1);$('plan').value=JSON.stringify(nodes,null,2);preview()};card.append(remove);$('planPreview').append(card)});$('checkPreview').replaceChildren();checks.forEach(function(check,index){var row=text('p',''),label=text('span',check.path+' / '+(check.contains||''));label.setAttribute('data-no-translate','');row.append(label);if(!check.contains)row.append(text('span','存在確認'));var remove=text('button','条件を外す');remove.onclick=function(){checks.splice(index,1);$('checks').value=JSON.stringify(checks,null,2);preview()};row.append(remove);$('checkPreview').append(row)})}
$('addNode').onclick=function(){perform($('addNode'),async function(){var nodes=JSON.parse($('plan').value);var id=$('nodeId').value.trim();if(!/^[a-zA-Z0-9_-]+$/.test(id)||nodes.some(n=>n.id===id))throw Error('工程IDは重複しない英数字で入力してください。');if(!$('nodeAcceptance').value.trim())throw Error('工程への依頼を入力してください。');nodes.push({id:id,dependencies:$('nodeDependencies').value.split(',').map(x=>x.trim()).filter(Boolean),inputs:$('nodeInputs').value.split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean),allowedWritePaths:$('nodeWrites').value.split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean),acceptance:$('nodeAcceptance').value.trim(),sideEffect:false});$('plan').value=JSON.stringify(nodes,null,2);preview()})};
$('addCheck').onclick=function(){perform($('addCheck'),async function(){var checks=JSON.parse($('checks').value);if(!$('checkPath').value.trim())throw Error('成果物の相対パスを入力してください。');checks.push({path:$('checkPath').value.trim(),...($('checkContains').value?{contains:$('checkContains').value}:{})});$('checks').value=JSON.stringify(checks,null,2);preview()})};
$('previewPlan').onclick=function(){perform($('previewPlan'),async function(){preview()})};$('workflowSearch').oninput=renderList;$('workflowFilter').onchange=renderList;preview();
window.addEventListener('hashchange',()=>{selected=decodeURIComponent(location.hash.slice(1));renderList();renderDetail()});
refreshList().catch(function(error){notice(error.message)});setInterval(()=>{if($('workflowAuto').checked&&!document.hidden)refreshList().catch(error=>notice(error.message+' 前回の情報を表示しています。'))},10000);
})();
</script></body></html>`, 'workflows', '並列工程', '工程を組み立て、進捗と差分を確認し、失敗した工程を再試行。');

/** 並列工程編集画面をホストFastifyアプリへ登録する（Register Workflow Center）。 */
export function registerWorkflowCenter(app: FastifyInstance, authorize: (req: FastifyRequest, reply: FastifyReply) => boolean | Promise<boolean>) {
  app.get('/workflows', async (req, reply) => {
    // 画面自体もAPIと同じ権限要求を通す（未認証では設計情報を見せない）。
    if (!await authorize(req, reply)) {
      if (!reply.sent) reply.code(403).type('text/plain; charset=utf-8').send('並列作業の管理権限が必要です。');
      return reply;
    }
    // インラインスクリプトのみ許可するCSP（Content Security Policy）。外部読み込みとキー保存は不可。
    reply.header('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    return reply.type('text/html; charset=utf-8').send(workflowCenterHtml);
  });
}
