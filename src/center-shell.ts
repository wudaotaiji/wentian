import { withAppearance } from './appearance-ui.js';
import { navigationStyle, controlCenterHeader, navigationRail, navigationHeading, controlCenterViews, navigationPersistenceScript } from './navigation-ui.js';

/** 管理画面と工作台のナビゲーション・テーマを共用し、各機能の入力やAPIを変更せず包みます。 */
export function withCenterShell(html: string, active: 'operations' | 'workflows' | 'projects' | 'account' | 'direct-messages' | 'mcp' | 'model-training' | 'menu-settings' | 'meetings' | 'execution-permissions', title: string, lead: string): string {
  const rail = navigationRail(false, active, true);
  const header = controlCenterHeader(true);
  const styles = `<style>
*{box-sizing:border-box}body{margin:0;max-width:none;padding:0;color:var(--text);background:var(--bg)}header{display:flex;align-items:center;justify-content:space-between;gap:20px}header p{margin:3px 0 0}header label{margin:0;font-size:12px}.controls,.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.nav-rail a[aria-current=page]{background:#8ba9ff1c;color:var(--accent);border-color:#8ba9ff30}main{min-width:0}section,article.panel{background:var(--panel);border:1px solid var(--line);padding:20px;margin-bottom:18px}.center-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0}.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}.card strong{display:block;font-size:26px;color:var(--text)}.muted,small{color:var(--muted)}label{display:block}input,select,textarea,button{color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:9px 12px;font:inherit}input,textarea,select{max-width:100%}textarea{width:100%;resize:vertical}button{cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}button.primary{background:var(--accent);color:#10192c}pre{background:var(--bg);padding:14px;border-radius:10px;overflow:auto;overflow-wrap:anywhere;white-space:pre-wrap;max-height:360px}table{width:100%;border-collapse:collapse;background:transparent}td,th{border-bottom:1px solid var(--line);padding:12px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{color:var(--muted)}.table-scroll{overflow:auto}.empty{padding:24px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:12px}.badge{display:inline-block;padding:3px 9px;border-radius:20px;background:#8ba9ff20;color:var(--accent)}.badge[data-status=failed],.badge[data-status=blocked]{background:#fb718522;color:#fb7185}.badge[data-status=completed],.badge[data-status=success]{background:#4ade8022;color:#4ade80}#notice{color:#f6cb75;white-space:pre-wrap;min-height:24px}#notice:empty{display:none}progress{width:100%;accent-color:var(--accent)}.node-card{border-left:3px solid var(--accent);padding:12px;background:var(--bg);margin:8px 0;border-radius:8px}.row{display:flex;gap:16px}.row>*{flex:1;min-width:0}[hidden]{display:none!important}html[data-theme=light] #notice{color:#9b351c}html[data-theme=light] .nav-rail a[aria-current=page]{color:#285ec5}@media(max-width:900px){.center-grid,.grid{grid-template-columns:1fr}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.row{flex-wrap:wrap}}@media(max-width:650px){header{flex-wrap:wrap}.nav-rail nav a{white-space:nowrap;width:auto}.nav-rail nav{display:flex;overflow:auto}.table-scroll table{min-width:620px}}
#nodeInputs,#nodeWrites,#nodeAcceptance{min-height:72px}#nodeId,#nodeDependencies,#checkPath,#checkContains,#workflowSearch{display:block;width:100%}
</style>`;
  let page = html.replace(/<header>[\s\S]*?<\/header>/, '').replace(/<nav>[\s\S]*?<\/nav>/, '');
  const bodyAt = page.indexOf('<body>');
  if (bodyAt < 0) throw new Error('画面にbody要素が必要です。');
  page = page.replace('<body>', '<body>' + rail + header);
  page = page.replace('<main>', '<main>' + navigationHeading(title, lead));
  const identity = `<script>(()=>{
    ${navigationPersistenceScript}
    const definitions=${JSON.stringify(controlCenterViews)},search=document.getElementById('navSearch'),results=document.getElementById('navResults');
    const restricted=document.querySelectorAll('.nav-rail [data-view^=site]');
    for(const item of restricted)item.hidden=true;
    fetch('/api/control-center/me').then(r=>r.ok?r.json():null).then(data=>{
      if(data?.user){document.getElementById('centerUser').textContent=(data.user.displayName||data.user.username||data.user.id)+' · '+data.user.role;for(const item of restricted)item.hidden=data.user.role!=='admin';}
    }).catch(()=>{});
    search.oninput=()=>{results.replaceChildren();const q=search.value.trim().toLowerCase();results.hidden=!q;if(!q)return;for(const link of document.querySelectorAll('.nav-rail nav a')){const definition=definitions.find(item=>item[0]===link.dataset.view);const label=link.textContent,description=definition?.[2]||'';if(link.hidden||!(label+' '+description+' '+link.href).toLowerCase().includes(q))continue;const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=()=>{location.href=link.href};results.append(button);}if(!results.childElementCount)results.textContent='一致する機能がありません。';};
    search.onkeydown=e=>{if(e.key==='Escape'){results.hidden=true;search.value='';}if(e.key==='Enter'){e.preventDefault();results.querySelector('button')?.click();}};
    document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();search.focus();}});
    document.addEventListener('click',e=>{if(!e.target.closest('.nav-search-wrap'))results.hidden=true;});
    document.getElementById('centerRefresh').onclick=()=>location.reload();
    document.getElementById('centerLogout').onclick=async()=>{const response=await fetch('/api/control-center/logout',{method:'POST'});if(response.ok)location.href='/';};
  })();</script>`;
  return withAppearance(page.replace('</head>', navigationStyle + styles + '</head>').replace('</body>', identity + '</body>'));
}
