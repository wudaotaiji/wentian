/** 外部Agent画面に設定・実行状態・開始停止を集約します。 */
export const agentMaintenanceHtml = `<section id="agentMaintenance" aria-label="自動保守の統一管理" style="margin:16px 0;padding:16px;border:1px solid var(--border);border-radius:12px">
<style>
#agentMaintenance{min-width:0;max-width:100%;box-sizing:border-box;overflow-x:clip;overflow-wrap:anywhere}
#agentMaintenance button{font:inherit;padding:10px 14px;border:1px solid var(--line,#52647a);border-radius:6px;background:var(--panel,#173b65);color:var(--text,#edf2fa);cursor:pointer}
#agentMaintenance button:disabled{opacity:.5;cursor:not-allowed}
#agentMaintenance #maintenanceControlsSave{background:#1d4ed8;color:#fff;border-color:#1d4ed8;font-weight:800}
#agentMaintenance .maintenance-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
#agentMaintenance .maintenance-header h3{margin:0 0 6px;font-size:1.3rem}
#agentMaintenance .maintenance-header p{margin:0;color:var(--muted,#a4b3c7)}
#agentMaintenance .maintenance-effective-setting{display:flex;flex-direction:column;align-items:flex-end;gap:6px;max-width:100%}
#agentMaintenance .maintenance-effective-setting .maintenance-resource-badge{white-space:normal}
#agentMaintenance .maintenance-effective-setting small{color:var(--muted,#a4b3c7)}
#agentMaintenance .maintenance-overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:20px 0}
#agentMaintenance .maintenance-overview>div{border:1px solid var(--line,#52647a);border-radius:10px;padding:16px;background:var(--panel,transparent);min-width:0}
#agentMaintenance .maintenance-overview dt{font-size:.85rem;color:var(--muted,#a4b3c7);margin-bottom:10px;font-weight:700}
#agentMaintenance .maintenance-overview dd{margin:0;overflow-wrap:anywhere;font-size:1.05rem;font-weight:800;line-height:1.6}
#agentMaintenance .maintenance-overview small{display:block;color:var(--muted,#a4b3c7);margin-top:8px;font-size:.8rem;font-weight:400}
#agentMaintenance .maintenance-overview .maintenance-resource-badge{white-space:normal}
#agentMaintenance .maintenance-alert{padding:14px 16px;border:1px solid #fca5a5;border-left:5px solid #b91c1c;border-radius:8px;background:#fee2e2;color:#7f1d1d;font-weight:700;line-height:1.6;margin:12px 0}
#agentMaintenance .maintenance-alert:empty{display:none}
#agentMaintenance .maintenance-details-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:20px 0}
#agentMaintenance .maintenance-details-grid h4{margin:0 0 12px}
#agentMaintenance .maintenance-detail-table{width:100%;border-collapse:collapse;font-size:.9rem}
#agentMaintenance .maintenance-detail-table th,#agentMaintenance .maintenance-detail-table td{padding:11px 12px;border-bottom:1px solid var(--line,#52647a);text-align:left;overflow-wrap:anywhere}
#agentMaintenance .maintenance-detail-table th{background:#173b65;color:white;width:38%;font-weight:700}
#agentMaintenance .maintenance-agent-list{display:flex;gap:6px;flex-wrap:wrap}
#agentMaintenance .maintenance-agent-chip{padding:3px 8px;border:1px solid var(--line,#52647a);border-radius:5px;font-weight:600}
#agentMaintenance .maintenance-settings{border:1px solid var(--line,#52647a);border-radius:10px;padding:14px 16px;margin-top:20px}
#agentMaintenance .maintenance-settings summary{font-weight:800;cursor:pointer}
#agentMaintenance .maintenance-settings form{margin-top:16px}
#agentMaintenance .maintenance-settings .controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:center}
#agentMaintenance .maintenance-settings input[type=number]{display:block;width:100%;box-sizing:border-box;margin-top:6px}
#agentMaintenance .maintenance-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
@media(max-width:850px){#agentMaintenance .maintenance-overview{grid-template-columns:repeat(2,minmax(0,1fr))}#agentMaintenance .maintenance-details-grid{grid-template-columns:1fr}}
@media(max-width:480px){#agentMaintenance .maintenance-overview{grid-template-columns:1fr}#agentMaintenance .maintenance-settings .controls{grid-template-columns:1fr}}
#agentMaintenance .maintenance-resource-heading{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:20px 0 12px}
#agentMaintenance .maintenance-resource-heading h4{margin:0;font-size:1.1rem}
#agentMaintenance .maintenance-resource-table-wrap{overflow-x:auto;border:1px solid var(--line,#52647a);border-radius:10px}
#agentMaintenance .maintenance-resource-table{width:100%;min-width:580px;border-collapse:collapse;margin:0;font-variant-numeric:tabular-nums}
#agentMaintenance .maintenance-resource-table thead th{background:#173b65;color:#fff;font-weight:800;padding:13px 16px;text-align:left;border-bottom:2px solid #628fbe;white-space:nowrap}
#agentMaintenance .maintenance-resource-table tbody th,#agentMaintenance .maintenance-resource-table td{padding:13px 16px;border-bottom:1px solid var(--line,#52647a);text-align:left;vertical-align:middle}
#agentMaintenance .maintenance-resource-table tbody th{background:transparent;color:var(--text);font-weight:700;white-space:nowrap}
#agentMaintenance .maintenance-resource-table tbody tr:last-child>*{border-bottom:0}
#agentMaintenance .maintenance-resource-badge{display:inline-block;padding:5px 10px;border-radius:6px;font-size:.9rem;font-weight:800;line-height:1.4;white-space:nowrap;border:1px solid currentColor}
#agentMaintenance .maintenance-resource-badge[data-level=normal]{background:#dcfce7;color:#14532d}
#agentMaintenance .maintenance-resource-badge[data-level=warning]{background:#fef3c7;color:#78350f}
#agentMaintenance .maintenance-resource-badge[data-level=paused]{background:#fee2e2;color:#991b1b}
#agentMaintenance .maintenance-resource-badge[data-level=unknown]{background:#e2e8f0;color:#334155}
#agentMaintenance .maintenance-resource-value{font-size:1.2rem;font-weight:800}
#agentMaintenance tr[data-level=warning] .maintenance-resource-value{background:#fef3c7;color:#78350f;padding:2px 6px;border-radius:4px}
#agentMaintenance tr[data-level=paused] .maintenance-resource-value{background:#fee2e2;color:#991b1b;padding:2px 6px;border-radius:4px}
#agentMaintenance .maintenance-resource-track{height:6px;background:#cbd5e1;border-radius:4px;margin-top:7px;overflow:hidden;min-width:100px}
#agentMaintenance .maintenance-resource-fill{height:100%;background:#15803d;width:0}
#agentMaintenance tr[data-level=warning] .maintenance-resource-fill{background:#b45309}
#agentMaintenance tr[data-level=paused] .maintenance-resource-fill{background:#b91c1c}
#agentMaintenance .maintenance-resource-note{margin:10px 0 20px;line-height:1.7}
</style>
<div class="maintenance-header"><div><h3>自動保守の統一管理</h3><p>実行主体：Wentian内蔵Daemon</p></div><div class="maintenance-effective-setting"><span id="maintenanceEnabled" class="maintenance-resource-badge" data-level="unknown" role="status">状態を取得中</span><small id="maintenanceSavedSetting">保存設定：未取得</small></div></div>
<dl class="maintenance-overview">
<div><dt>保守状態</dt><dd><span id="maintenanceStatus" class="maintenance-resource-badge" data-level="unknown" role="status">取得中…</span></dd><small id="maintenanceReason">状態を確認しています</small></div>
<div><dt>処理中のAgent</dt><dd id="maintenanceCurrentAgent">—</dd><small>現在実行している対象</small></div>
<div><dt>実行段階</dt><dd id="maintenanceStage">—</dd><small>CLI確認・接続・作業検証</small></div>
<div><dt>次回実行予定</dt><dd id="maintenanceNextRun">—</dd><small>保守管理器に登録された予約</small></div>
</dl>
<p id="maintenanceError" class="maintenance-alert" role="alert"></p>
<p id="maintenanceAccessStatus" role="status"></p><p>自動保守は専用領域を既定で使用します。Agentごとの期限付き許可は不要です。プロジェクトでの作業は一度の範囲設定を再利用します。</p><p>利用の一時停止と権限の取消は別の設定です。</p><p><a href="/execution-permissions">実行範囲・プロジェクトの設定</a></p>
<section class="maintenance-settings" aria-label="AI保守の判断"><h4>AI保守の判断</h4><p>証跡を基に調査・復旧・再検証を選択します。実行許可と資源保護は常に適用されます。</p><div id="maintenanceAiReports" aria-live="polite">判断記録はまだありません。</div></section>
<form id="maintenanceControlsForm" class="maintenance-settings" aria-label="バックグラウンド保守の実行許可">
<h4 style="margin:0 0 12px">バックグラウンド保守の実行許可</h4>
<p class="muted">管理者がここで許可・禁止を保存できます。保存後すぐに反映し、Daemonの再起動は不要です。許可しても資源保護や未ロードモデルの保留は適用されます。</p>
<div class="maintenance-resource-table-wrap"><table class="maintenance-resource-table"><thead><tr><th scope="col">対象</th><th scope="col">現在の実行許可</th><th scope="col">設定元</th><th scope="col">変更する値</th></tr></thead><tbody>
${[['connection','Agent接続・作業保守'],['media','メディアモデル保守']].map(([key,label])=>`<tr><th scope="row">${label}</th><td><span id="maintenanceControl-${key}-status" class="maintenance-resource-badge" data-level="unknown">未取得</span></td><td id="maintenanceControl-${key}-source">—</td><td><label><input id="maintenanceControl-${key}" type="checkbox" disabled>${label}を許可</label></td></tr>`).join('')}
</tbody></table></div>
<p id="maintenanceControlEnvironment" class="muted"></p>
<button id="maintenanceControlsSave" type="submit" disabled>実行許可を保存・反映</button>
<p id="maintenanceControlsMessage" role="status" aria-live="polite"></p>
</form>
<div class="maintenance-actions"><button data-maintenance-action="start">自動保守を開始</button><button data-maintenance-action="stop">自動保守を停止</button><button data-maintenance-action="run">全対象を今すぐ確認</button></div>
<div class="maintenance-resource-heading"><h4 id="maintenanceResourceTitle">システム資源</h4><span id="maintenanceResources" class="maintenance-resource-badge" data-level="unknown" role="status">未計測</span></div>
<p class="muted"><span id="maintenanceResourceMeasured">未計測</span> <span id="maintenanceResourceReason"></span></p>
<div class="maintenance-resource-table-wrap"><table class="maintenance-resource-table" aria-labelledby="maintenanceResourceTitle">
<thead><tr><th scope="col">監視項目</th><th scope="col">現在の使用率</th><th scope="col">判定</th><th scope="col">警告しきい値</th><th scope="col">停止しきい値</th></tr></thead>
<tbody>${[['cpu','CPU'],['memory','メモリ'],['disk','ディスク稼働率'],['diskCapacity','ディスク容量使用率'],['network','ネットワーク']].map(([key,label])=>`<tr data-resource="${key}" data-level="unknown"><th scope="row">${label}</th><td><strong class="maintenance-resource-value">—</strong><div class="maintenance-resource-track" aria-hidden="true"><div class="maintenance-resource-fill"></div></div></td><td><span class="maintenance-resource-badge maintenance-resource-state" data-level="unknown">未計測</span></td><td><span class="maintenance-resource-badge" data-level="warning">80%以上</span></td><td><span class="maintenance-resource-badge" data-level="paused">90%以上</span></td></tr>`).join('')}</tbody>
</table></div>
<p class="maintenance-resource-note">いずれかが <strong class="maintenance-resource-badge" data-level="warning">80%以上で警告</strong>、<strong class="maintenance-resource-badge" data-level="paused">90%以上で保守を一時停止</strong>。停止後は<strong>全項目が90%未満</strong>に回復してから再開します。容量使用率も対象です。連続停止時は再確認の間隔を延長します。計測不能時も保守を一時停止します。</p>
<div class="maintenance-details-grid">
<div><h4>実行スケジュール</h4><table id="maintenanceSchedule" class="maintenance-detail-table" aria-label="実行スケジュール"><tbody>
<tr><th scope="row">今回開始</th><td id="maintenanceStarted">—</td></tr><tr><th scope="row">最終終了</th><td id="maintenanceFinished">—</td></tr><tr><th scope="row">実際の次回実行:</th><td id="maintenanceScheduled">なし</td></tr><tr><th scope="row">手動確認の待機</th><td id="maintenancePending">なし</td></tr>
</tbody></table></div>
<div><h4>保守対象</h4><table id="maintenanceTargets" class="maintenance-detail-table" aria-label="保守対象"><tbody>
<tr><th scope="row">保守対象</th><td><div id="maintenanceTargetList" class="maintenance-agent-list">なし</div></td></tr><tr><th scope="row">一時停止</th><td><div id="maintenanceExcludedList" class="maintenance-agent-list">なし</div></td></tr>
</tbody></table></div></div>
<details class="maintenance-settings"><summary>保守設定・自動導入・作業検証</summary><p class="muted">設定は保存され、再起動後も復元されます。各Agentの一時停止は維持されます。</p>
<form id="maintenanceForm"><div class="controls">
<label>通常確認間隔（秒）<input id="maintenanceInterval" type="number" min="10" max="86400" required></label>
<label>失敗時の再確認間隔（秒）<input id="maintenanceRetry" type="number" min="10" max="86400" required></label>
<label><input id="maintenanceInstall" type="checkbox">未導入CLIの自動導入</label>
<label><input id="maintenanceWork" type="checkbox">隔離した作業場所で実作業を検証</label>
<button id="maintenanceSave" type="submit">保守設定を保存</button></div></form></details>
<p class="muted">停止は実行中の保守も中断します。停止中でも「今すぐ確認」「再確認」は一回だけ実行します。自動導入は外部からCLIを取得し、実作業検証はモデルを使用します。</p>
</section>`;

export const agentMaintenanceScript = String.raw`
(()=>{
 const root=document.getElementById('agentMaintenance');if(!root)return;
 const el=id=>document.getElementById(id),endpoint='/v1/manager/external-agents/maintenance';
 let dirty=false,busy=false,admin=false,latest,actionError='';
 let controls,controlsDirty=false,controlsBusy=false;
 const controlsEndpoint='/v1/manager/maintenance-controls';
 const uiValue=uiKey=>({uiKey});
 function message(id,key,params={}){
  const node=el(id);
  if(window.wentianUi?.message){window.wentianUi.message(node,key,params);return;}
  node.setAttribute('data-ui-message',key);node.setAttribute('data-ui-params',JSON.stringify(params));
  node.textContent=key.replace(/\{(\w+)\}/g,(_match,name)=>params[name]?.uiKey??params[name]??'');
 }

 function renderControls(){
  const sources={management:'管理画面の保存設定',environment:'起動時の環境設定',default:'既定値',error:'設定読込エラー'};
  ['connection','media'].forEach(key=>{
    const entry=controls?.[key],input=el('maintenanceControl-'+key),badge=el('maintenanceControl-'+key+'-status');
    input.disabled=busy||controlsBusy||!admin||!entry||entry.editable===false;
    if(entry){
      if(!controlsDirty)input.checked=entry.allowed;
      badge.textContent=entry.allowed?'許可':'禁止';badge.dataset.level=entry.allowed?'normal':'paused';
      el('maintenanceControl-'+key+'-source').textContent=entry.editable===false?'サーバー起動オプションで固定':sources[entry.source]||'未確認';
    }
  });
  el('maintenanceControlsSave').disabled=busy||controlsBusy||!admin||!controls;
  if(controls)message('maintenanceControlEnvironment','起動環境の初期値：Agent保守 {connection} / メディア保守 {media}。管理画面の保存設定が優先します。',{connection:uiValue(controls.connection.environmentAllowed?'許可':'禁止'),media:uiValue(controls.media.environmentAllowed?'許可':'禁止')});
  else message('maintenanceControlEnvironment','管理者としてログインすると実行許可を確認・変更できます。');
 }
 async function loadControls(){
  if(!admin||controlsBusy)return;
  const response=await fetch(controlsEndpoint);const data=await response.json();
  if(!response.ok){controls=undefined;renderControls();throw new Error(data.error?.message||'実行許可を取得できません。');}
  controls=data;renderControls();
 }
 const labels={starting:'開始準備中',running:'保守実行中',stopping:'保守停止処理中',waiting:'次回実行待ち',stopped:'自動保守停止中',disabled:'環境設定で無効',error:'保守エラー'};
 const date=value=>value?new Date(value).toLocaleString(({ja:'ja-JP',en:'en-US',zh:'zh-CN'})[window.wentianUi?.language?.()||'ja']):'なし';
 const apply=()=>window.wentianUi?.apply();
 async function request(body){const response=await fetch(endpoint,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'保守情報を取得できません。');return data;}
 function render(data){latest=data;if(!data?.settings){el('maintenanceStatus').textContent='保守情報を取得できません。';return;}
  el('maintenanceAccessStatus').textContent=data.executionAccess?.policyError?'実行範囲の設定を確認できません。':data.executionAccess?.maintenanceDefault?'保守の既定権限：有効（期限なし）':'保守の既定権限：無効（利用者設定または上位設定）';
  const blocked=data.state==='disabled'||data.constraints?.connectionDisabled===true;
  const paused=!blocked&&(data.resourcePaused===true||(data.resourcePaused===undefined&&['paused','unknown'].includes(data.resources?.state)&&Boolean(data.lastError)));
  el('maintenanceStatus').textContent=blocked?'実行許可により無効':paused?'資源保護による一時停止':(labels[data.state]||'状態未確認');
  el('maintenanceStatus').dataset.level=blocked||paused||data.state==='error'?'paused':data.state==='running'?'normal':'unknown';
  message('maintenanceEnabled','自動保守：{state}',{state:uiValue(blocked?'実行許可により無効':!data.settings.enabled?'停止':paused?'資源保護により一時停止':data.state==='error'?'エラー・再試行待ち':'有効')});
  el('maintenanceEnabled').dataset.level=blocked?'paused':!data.settings.enabled?'unknown':paused||data.state==='error'?'warning':'normal';
  message('maintenanceSavedSetting','保存設定：{state}{restriction}',{state:uiValue(data.settings.enabled?'有効':'停止'),restriction:blocked?uiValue('（現在は実行禁止）'):''});
  el('maintenanceReason').textContent=data.reason||(blocked?'実行許可の設定により実行できません。':paused?'資源の回復を待っています':'設定に従って保守を管理します');
  el('maintenanceCurrentAgent').textContent=[...new Set([data.currentAgent,...(data.activeAgents||[])].filter(Boolean))].join(', ')||'実行中のAgentなし';
  el('maintenanceStage').textContent=data.stage||'待機中';
  el('maintenanceNextRun').textContent=date(data.nextRunAt);
  const resourceLabels={normal:'通常',warning:'警告 · 80%以上',paused:'保守一時停止 · 90%以上',unknown:'計測不能 · 保守一時停止'};
  const usage=data.resources?.usage;
  const resourceState=Object.hasOwn(resourceLabels,data.resources?.state)?data.resources.state:'unknown';
  el('maintenanceResources').textContent=data.resources?(resourceState==='unknown'&&!paused?'計測不能':resourceLabels[resourceState]):'未計測';
  el('maintenanceResources').dataset.level=resourceState;
  if(data.resources?.checkedAt)message('maintenanceResourceMeasured','最終計測: {time}',{time:date(data.resources.checkedAt)});else el('maintenanceResourceMeasured').textContent='未計測';
  const resourceReason=data.resources?.reason||(paused&&['normal','warning'].includes(resourceState)?'資源は回復しました。次回の保守で再開を確認します。':paused&&resourceState==='paused'?(usage?.diskCapacity>=90?'ディスク容量使用率が90%以上のため保守を一時停止します。空き容量を確保してください。':'資源使用率が90%以上のため保守を一時停止します。'):'');
  el('maintenanceResourceReason').textContent=resourceReason;
  // 数値の表示上の閾値です。保守の可否はサーバーの資源制御が判断します。
  root.querySelectorAll('[data-resource]').forEach(row=>{
    const value=usage?.[row.dataset.resource];
    const valid=typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100;
    const level=!valid?'unknown':value>=90?'paused':value>=80?'warning':'normal';
    row.dataset.level=level;
    row.querySelector('.maintenance-resource-value').textContent=valid?value.toFixed(1)+'%':'—';
    const badge=row.querySelector('.maintenance-resource-state');
    badge.dataset.level=level;badge.textContent=({normal:'通常',warning:'警告',paused:'停止水準',unknown:'未計測'})[level];
    row.querySelector('.maintenance-resource-fill').style.width=valid?value+'%':'0%';
  });
  el('maintenanceStarted').textContent=date(data.startedAt);el('maintenanceFinished').textContent=date(data.finishedAt);
  el('maintenanceScheduled').textContent=date(data.nextRunAt);el('maintenancePending').textContent=data.pendingAgents?.join(', ')||'なし';
  const chips=(id,items)=>{const container=el(id);container.replaceChildren();if(!items?.length){container.textContent='なし';return;}items.forEach(name=>{const chip=document.createElement('span');chip.className='maintenance-agent-chip';chip.setAttribute('data-no-translate','');chip.textContent=name;container.append(chip);});};
  chips('maintenanceTargetList',data.targets);chips('maintenanceExcludedList',data.excludedAgents);
  if(!dirty&&!root.contains(document.activeElement)){el('maintenanceInterval').value=data.settings.intervalMs/1000;el('maintenanceRetry').value=data.settings.retryIntervalMs/1000;el('maintenanceInstall').checked=data.settings.autoInstall;el('maintenanceWork').checked=data.settings.verifyWork;}
  root.querySelectorAll('button,input').forEach(item=>item.disabled=busy||controlsBusy||!admin);
  el('maintenanceInstall').disabled=busy||controlsBusy||!admin||data.constraints?.autoInstallDisabled;
  root.querySelector('[data-maintenance-action="start"]').disabled=busy||controlsBusy||!admin||blocked||(data.settings.enabled&&data.state!=='error');
  root.querySelector('[data-maintenance-action="run"]').disabled=busy||controlsBusy||!admin||blocked||data.state==='error';
  el('maintenanceError').textContent=actionError||(paused&&resourceReason?resourceReason:data.lastError)||'';renderControls();apply();
 }
 let aiReports=[];
 function renderAI(){
  const container=el('maintenanceAiReports');container.replaceChildren();
  const lang=window.wentianUi?.language?.()||'ja';
  const labels={investigating:'AIが調査中',verified:'実証済み',waiting:'条件回復待ち',needs_approval:'承認が必要',implementation_required:'実装修正が必要',unconfirmed:'AI判断は未確認'};
  if(!admin){container.textContent='AI保守の判断は管理者として確認してください。';apply();return;}
  if(!aiReports.length){container.textContent='判断記録はまだありません。';apply();return;}
  for(const report of aiReports){
   const card=document.createElement('article');card.style.cssText='border-top:1px solid var(--line,#52647a);padding:12px 0;overflow-wrap:anywhere';
   const title=document.createElement('strong');title.textContent=report.agent+' · ';title.setAttribute('data-no-translate','');
   const state=document.createElement('span');state.textContent=labels[report.status]||'AI判断は未確認';card.append(title,state);
   if(report.decision)for(const key of ['diagnosis','nextStep']){const p=document.createElement('p');p.setAttribute('data-no-translate','');p.textContent=report.decision[key]?.[lang]||'';card.append(p);}
   if(report.plannerError){const p=document.createElement('p');p.textContent='AI判断を取得・検証できません。設定と証跡を確認し、次回の保守で再確認します。';card.append(p);}
   const evidence=document.createElement('small');evidence.setAttribute('data-no-translate','');evidence.textContent=[report.updatedAt,...(report.decision?.evidence||[])].join(' · ');card.append(evidence);container.append(card);
  }
  apply();
 }
 async function refresh(){try{const me=await fetch('/api/control-center/me');admin=me.ok&&(await me.json()).user?.role==='admin';render(await request());await loadControls();if(admin){const response=await fetch('/v1/manager/external-agents/maintenance/ai');if(response.ok)aiReports=(await response.json()).reports||[];}else aiReports=[];renderAI();}catch(error){el('maintenanceError').textContent=String(error.message);}}
 async function act(body){busy=true;actionError='';if(latest)render(latest);try{const data=await request(body);dirty=false;render(data);}catch(error){actionError=String(error.message);el('maintenanceError').textContent=actionError;}finally{busy=false;if(latest)render(latest);}}
 el('maintenanceForm').addEventListener('input',()=>{dirty=true;});
 el('maintenanceControlsForm').addEventListener('input',()=>{controlsDirty=true;});
 el('maintenanceControlsForm').addEventListener('submit',async event=>{
  event.preventDefault();if(!admin||controlsBusy||!controls)return;
  const patch={};['connection','media'].forEach(key=>{if(controls[key].editable!==false)patch[key]=el('maintenanceControl-'+key).checked;});
  controlsBusy=true;if(latest)render(latest);else renderControls();el('maintenanceControlsMessage').textContent='保存・反映中…';
  try{
    const response=await fetch(controlsEndpoint,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
    const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'実行許可を変更できません。');
    controls=data;controlsDirty=false;el('maintenanceControlsMessage').textContent=data.message||'実行許可を保存・反映しました。';
    render(await request());
  }catch(error){el('maintenanceControlsMessage').textContent=String(error.message);}
  finally{controlsBusy=false;if(latest)render(latest);else renderControls();}
 });
 el('maintenanceForm').addEventListener('submit',event=>{event.preventDefault();act({action:'configure',settings:{intervalMs:Number(el('maintenanceInterval').value)*1000,retryIntervalMs:Number(el('maintenanceRetry').value)*1000,autoInstall:el('maintenanceInstall').checked,verifyWork:el('maintenanceWork').checked}});});
 root.addEventListener('click',event=>{const button=event.target.closest('[data-maintenance-action]');if(button&&!busy)act({action:button.dataset.maintenanceAction});});
 document.addEventListener('wentian-control-refresh',refresh);
 document.addEventListener('wentian-language-changed',()=>{if(latest)render(latest);renderAI();});
 window.addEventListener('hashchange',()=>{if(location.hash==='#agents')refresh();});
 setInterval(()=>{if(location.hash==='#agents'&&!busy)refresh();},10000);
 refresh();
})();`;
