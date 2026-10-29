import re

with open(__import__('pathlib').Path(__file__).resolve().parents[1] / 'src' / 'dashboard.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace variable declarations
pattern1 = r"(const \$=id=>document\.getElementById\(id\).*?let apiKey='', timer, currentUser, needsSetup=false, chatMessages=\[\];)"
replacement1 = """const $=id=>document.getElementById(id), esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&','<':'<','>':'>','"':'"',"'":'''}[ch]));
const t=value=>window.wentianUi.t(value);const locale=()=>({ja:'ja-JP',en:'en-US',zh:'zh-CN'}[window.wentianUi.language()]);let apiKey='', currentUser, needsSetup=false, chatMessages=[];
const sectionTimers = new Map();
const AUTO_REFRESH_ENABLED = () => $('auto')?.checked ?? false;
function startTimer(section, fn, intervalMs) {
  if (sectionTimers.has(section)) clearInterval(sectionTimers.get(section));
  const timer = setInterval(() => { if (AUTO_REFRESH_ENABLED() && !document.hidden) fn(); }, intervalMs);
  sectionTimers.set(section, timer);
  fn();
}
function stopAllTimers() { for (const t of sectionTimers.values()) clearInterval(t); sectionTimers.clear(); }
function startAllTimers() { if (!currentUser) return; refreshNow(); }
function refreshNow() {
  renderMemorySafe(); renderModelsSafe(); renderProvidersSafe(); renderMetricsSafe();
  renderRoutesSafe(); renderPerformanceSafe(); renderRecommendationsSafe();
  renderExternalAgentsSafe(); renderMarketplaceSafe(); refreshWentianModelsSafe();
}"""

content = re.sub(pattern1, lambda m: replacement1, content, flags=re.DOTALL)

# Replace showLogin/showApplication
pattern2 = r"(function applyPreferences\(\)\{window\.wentianUi\.apply\(\)\}\s*function showLogin\(\)\{\$\('login'\)\.classList\.remove\('hidden'\);stopAllTimers\(\)\}\s*function showApplication\(user\)\{)"
replacement2 = """function applyPreferences(){window.wentianUi.apply()}
function showLogin(){$('login').classList.remove('hidden');stopAllTimers()}function showApplication(user){currentUser=user;$('login').classList.add('hidden');$('currentUser').textContent=user.displayName+' \\u30fb '+user.role;if(user.role==='admin')createUserPanel();loadChatModels();startAllTimers();refreshNow()}"""

content = re.sub(pattern2, lambda m: replacement2, content, flags=re.DOTALL)

# Replace the refresh function and auto handler
pattern3 = r"(let refreshing=false;async function refresh\(\).*?\$\('auto'\)\.addEventListener\('change',event=>\{clearInterval\(timer\);if\(event\.target\.checked&&currentUser\)timer=setInterval\(refresh,10000\)\}\);)"
replacement3 = """let refreshing=false;async function refresh(){document.dispatchEvent(new Event('wentian-control-refresh'));if(refreshing)return;refreshing=true;const button=$('refresh');button.disabled=true;$('message').textContent='';$('updated').textContent='更新中…';try{const core=await Promise.allSettled([get('/v1/manager/status',8000),get('/v1/manager/models',8000),get('/v1/providers',8000),get('/v1/metrics',8000),get('/v1/routing/recent',8000),get('/v1/manager/performance',8000),get('/v1/manager/recommendations',8000)]);const value=index=>core[index].status==='fulfilled'?core[index].value:undefined;const status=value(0);if(status)renderMemory(status);if(value(1))renderModels(value(1));if(value(2))renderProviders(value(2),status);if(value(3))renderMetrics(value(3),status);if(value(4))renderRoutes(value(4));if(value(5))renderPerformance(value(5));if(value(6))renderRecommendations(value(6));const coreErrors=core.filter(result=>result.status==='rejected').map(result=>String(result.reason));if(coreErrors.length)$('message').textContent=t('一部の管理情報を取得できません: ')+coreErrors.join(' / ');$('updated').textContent=t('基本情報更新: ')+new Date().toLocaleString(locale());const slow=await Promise.allSettled([get('/v1/manager/external-agents',20000),get('/v1/manager/agent-marketplace?limit=100',20000)]);if(slow[0].status==='fulfilled')renderExternalAgents(slow[0].value);else $('externalAgents').innerHTML='<div class="error">外部エージェント情報の取得がタイムアウトしました。</div>';if(slow[1].status==='fulfilled')renderMarketplace(slow[1].value);else $('marketplace').innerHTML='<div class="error">Marketplace情報の取得がタイムアウトしました。</div>';$('updated').textContent=t('最終更新: ')+new Date().toLocaleString(locale())}catch(error){$('message').textContent=t('管理情報の取得に失敗しました: ')+(error instanceof Error?error.message:String(error))}finally{refreshing=false;button.disabled=false;window.wentianUi.apply()}}
async function installAgent(agentId){const output=$('installResult');try{const plan=await post('/v1/manager/agent-install/plan',{agentId});output.textContent=JSON.stringify(plan,null,2);if(!confirm(plan.name+t(' をローカルへインストールしますか？')+'\\n\\n'+plan.executable+' '+plan.arguments.join(' ')))return;const approval=await post('/v1/manager/agent-install/approval',{agentId});if(!confirm(t('60秒・1回限りの承認を使ってインストールを実行しますか？')))return;output.textContent=t('インストール中です…');output.textContent=JSON.stringify(await post('/v1/manager/agent-install/execute',{agentId,approvalToken:approval.approvalToken}),null,2);await refresh()}catch(error){output.textContent=JSON.stringify({error:String(error)},null,2)}}
$('marketplace').addEventListener('click',async event=>{const install=event.target.closest('[data-install-agent]');if(install){void installAgent(install.dataset.installAgent);return}const button=event.target.closest('[data-marketplace-action]');if(!button)return;const id=button.dataset.agentId;if(marketplaceBusy.has(id))return;marketplaceBusy.add(id);button.closest('tr').querySelectorAll('[data-marketplace-action]').forEach(item=>item.disabled=true);const output=$('installResult');try{const result=await post('/v1/manager/agent-marketplace/'+encodeURIComponent(id)+'/registration',{action:button.dataset.marketplaceAction});renderExternalAgents(result.snapshot);output.textContent=id+(result.registered?' を一覧へ追加しました。':' を一覧から外しました。');marketplaceBusy.delete(id);renderMarketplace(await get('/v1/manager/agent-marketplace?limit=100',20000))}catch(error){output.textContent='一覧登録の変更に失敗しました: '+String(error)}finally{marketplaceBusy.delete(id);void refresh()}});
$('agentRegister').addEventListener('click',async()=>{const output=$('agentRegisterResult');try{const result=await post('/v1/manager/external-agents',{id:$('agentId').value,name:$('agentName').value,cli:$('agentCli').value,repository:$('agentRepo').value});output.textContent=t('登録しました: ')+result.name;await refresh()}catch(error){output.textContent=t('登録に失敗しました: ')+String(error)}});
let approvalToken='';const lifeTarget=()=>({provider:$('lifeProvider').value.trim(),model:$('lifeModel').value.trim(),action:$('lifeAction').value});const showLife=value=>{$('lifeResult').textContent=JSON.stringify(value,null,2)};$('lifePlan').addEventListener('click',async()=>{try{showLife(await post('/v1/manager/lifecycle/plan',lifeTarget()))}catch(error){showLife({error:String(error)})}});$('lifeApprove').addEventListener('click',async()=>{try{const result=await post('/v1/manager/lifecycle/approval',lifeTarget());approvalToken=result.approvalToken;showLife({...result,approvalToken:'発行済み（画面メモリ内）'})}catch(error){showLife({error:String(error)})}});$('lifeExecute').addEventListener('click',async()=>{if(!approvalToken||!confirm(t('このモデル状態変更を実行しますか？')))return;try{showLife(await post('/v1/manager/lifecycle/execute',{target:lifeTarget(),approvalToken}));approvalToken='';refresh()}catch(error){showLife({error:String(error)})}});$('refresh').addEventListener('click',refreshNow);$('auto').addEventListener('change',event=>{if(event.target.checked&&currentUser){startTimer('memory',renderMemorySafe,10000);startTimer('models',renderModelsSafe,30000);startTimer('providers',renderProvidersSafe,30000);startTimer('metrics',renderMetricsSafe,15000);startTimer('routes',renderRoutesSafe,15000);startTimer('performance',renderPerformanceSafe,60000);startTimer('recommendations',renderRecommendationsSafe,60000);startTimer('external-agents',renderExternalAgentsSafe,10000);startTimer('marketplace',renderMarketplaceSafe,30000);startTimer('wentian-models',refreshWentianModelsSafe,60000);}else{stopAllTimers();}});"""

content = re.sub(pattern3, lambda m: replacement3, content, flags=re.DOTALL)

# Add Safe wrapper functions for each render function
safe_wrappers = """
// Safe wrapper functions for individual section updates
async function renderMemorySafe(){try{const status=await get('/v1/manager/status',8000);if(status)renderMemory(status);}catch(e){console.warn('Memory refresh failed:',e)}}
async function renderModelsSafe(){try{const payload=await get('/v1/manager/models',8000);renderModels(payload);}catch(e){console.warn('Models refresh failed:',e)}}
async function renderProvidersSafe(){try{const [payload,status]=await Promise.all([get('/v1/providers',8000),get('/v1/manager/status',8000)]);renderProviders(payload,status);}catch(e){console.warn('Providers refresh failed:',e)}}
async function renderMetricsSafe(){try{const [data,status]=await Promise.all([get('/v1/metrics',8000),get('/v1/manager/status',8000)]);renderMetrics(data,status);}catch(e){console.warn('Metrics refresh failed:',e)}}
async function renderRoutesSafe(){try{const payload=await get('/v1/routing/recent',8000);renderRoutes(payload);}catch(e){console.warn('Routes refresh failed:',e)}}
async function renderPerformanceSafe(){try{const payload=await get('/v1/manager/performance',8000);renderPerformance(payload);}catch(e){console.warn('Performance refresh failed:',e)}}
async function renderRecommendationsSafe(){try{const payload=await get('/v1/manager/recommendations',8000);renderRecommendations(payload);}catch(e){console.warn('Recommendations refresh failed:',e)}}
async function renderExternalAgentsSafe(){try{const payload=await get('/v1/manager/external-agents',20000);renderExternalAgents(payload);}catch(e){console.warn('ExternalAgents refresh failed:',e);$('externalAgents').innerHTML='<div class="error">外部エージェント情報の取得に失敗しました。</div>';}}
async function renderMarketplaceSafe(){try{const payload=await get('/v1/manager/agent-marketplace?limit=100',20000);renderMarketplace(payload);}catch(e){console.warn('Marketplace refresh failed:',e);$('marketplace').innerHTML='<div class="error">Marketplace情報の取得に失敗しました。</div>';}}
async function refreshWentianModelsSafe(){try{const response=await fetch('/v1/manager/wentian-models');if(!response.ok)throw new Error('HTTP '+response.status);const payload=await response.json();const host=document.getElementById('wentianModels');const rows=(payload.items||[]).map(item=>'<tr><td><strong>'+esc(item.name)+'</strong><br><code>'+esc(item.id)+'</code></td><td>'+esc(item.type)+'</td><td>'+esc(item.baseModel)+'</td><td><span class="badge">'+esc(item.status)+'</span></td><td>'+esc(item.active?'Yes':'No')+'</td><td>'+esc(typeof item.evaluation==='number'?(item.evaluation*100).toFixed(1)+'%':'—')+'</td><td>'+esc(item.examples??'—')+'</td></tr>').join('');host.innerHTML=rows?'<table><thead><tr><th>Wentianモデル</th><th>用途</th><th>基盤モデル</th><th>状態</th><th>有効</th><th>独立評価</th><th>学習例</th></tr></thead><tbody>'+rows+'</tbody></table>':'<div class="empty">Wentianの学習モデルはありません</div>';window.wentianUi.apply()}catch(error){const host=document.getElementById('wentianModels');host.innerHTML='<div class="error">Wentian学習モデルを取得できません: '+esc(error.message)+'</div>';}}

// Insert safe wrappers before the installAgent function
"""

# Insert safe wrappers before installAgent
content = content.replace('async function installAgent(agentId){', safe_wrappers + '\nasync function installAgent(agentId){')

with open(__import__('pathlib').Path(__file__).resolve().parents[1] / 'src' / 'dashboard.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("Done")