import re

with open(__import__('pathlib').Path(__file__).resolve().parents[1] / 'src' / 'dashboard.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Variable declarations and showLogin/showApplication
old1 = r"""const \$=id=>document\.getElementById\(id\), esc=value=>String\(value\?\?'\)\.replace\(/\[&<>"'\]/g,ch=>\(\{'&':'&','<':'<','>':'>','"':'"',"'":'''}\[ch\]\)\);
const t=value=>window\.wentianUi\.t\(value\);const locale=\(\)=>\(\{ja:'ja-JP',en:'en-US',zh:'zh-CN'\}\[window\.wentianUi\.language\(\)\]\);let apiKey='', timer, currentUser, needsSetup=false, chatMessages=\[\];
function applyPreferences\(\)\{window\.wentianUi\.apply\(\}\)\}
function showLogin\(\)\{\$\( 'login' \)\.classList\.remove\('hidden'\);clearInterval\(timer\)\}function showApplication\(user\)\{currentUser=user;\$\( 'login' \)\.classList\.add\('hidden'\);\$\( 'currentUser' \)\.textContent=user\.displayName\+' \u30fb '+user\.role;if\(user\.role==='admin'\)createUserPanel\(\);refresh\(\);loadChatModels\(\);timer=setInterval\(refresh,10000\)\}"""

new1 = """const $=id=>document.getElementById(id), esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&','<':'<','>':'>','"':'"',"'":'''}[ch]));
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
}
function applyPreferences(){window.wentianUi.apply()}
function showLogin(){$('login').classList.remove('hidden');stopAllTimers()}function showApplication(user){currentUser=user;$('login').classList.add('hidden');$('currentUser').textContent=user.displayName+' · '+user.role;if(user.role==='admin')createUserPanel();loadChatModels();startAllTimers();refreshNow()}"""

content = re.sub(old1, new1, content, flags=re.DOTALL)

# 2. Auto checkbox event handler
old2 = r"""\$\('refresh'\)\.addEventListener\('click',refresh\);\$\( 'auto' \)\.addEventListener\('change',event=>\{clearInterval\(timer\);if\(event\.target\.checked\&\&currentUser\)timer=setInterval\(refresh,10000\)\}\)\);"""

new2 = """$('refresh').addEventListener('click',refreshNow);$('auto').addEventListener('change',event=>{if(event.target.checked&&currentUser){startTimer('memory',renderMemorySafe,10000);startTimer('models',renderModelsSafe,30000);startTimer('providers',renderProvidersSafe,30000);startTimer('metrics',renderMetricsSafe,15000);startTimer('routes',renderRoutesSafe,15000);startTimer('performance',renderPerformanceSafe,60000);startTimer('recommendations',renderRecommendationsSafe,60000);startTimer('external-agents',renderExternalAgentsSafe,10000);startTimer('marketplace',renderMarketplaceSafe,30000);startTimer('wentian-models',refreshWentianModelsSafe,60000);}else{stopAllTimers();}});"""

content = re.sub(old2, new2, content)

# 3. Add safe wrapper functions before installAgent
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

content = content.replace('async function installAgent(agentId){', safe_wrappers + '\nasync function installAgent(agentId){')

with open(__import__('pathlib').Path(__file__).resolve().parents[1] / 'src' / 'dashboard.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("Done")