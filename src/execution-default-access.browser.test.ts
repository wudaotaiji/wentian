import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { chromium } from 'playwright';
import { registerExecutionGovernance } from './execution-governance-routes.js';

// 明示した証跡保存先があるときだけ実ブラウザー検証を実施します。通常の単体試験では起動しません。
test('日英中・デスクトップ・狭幅の実ブラウザーで既定設定と一度のプロジェクト許可を操作する', {skip:!process.env.WENTIAN_VISUAL_OUTPUT,timeout:90000}, async t=>{
  const output=path.resolve(process.env.WENTIAN_VISUAL_OUTPUT!),root=await mkdtemp(path.join(os.tmpdir(),'wentian-access-browser-'));
  await mkdir(output,{recursive:true});await mkdir(path.join(root,'project'));
  // 画面から保存する設定・接続先・監査・Agent状態は利用者の環境と完全に分けます。
  const env={WENTIAN_EXECUTION_POLICY_FILE:path.join(root,'policy.json'),WENTIAN_EXECUTION_AUDIT_FILE:path.join(root,'audit.jsonl'),WENTIAN_AGENT_CONNECTION_CACHE:path.join(root,'connections.json'),WENTIAN_AGENT_EXCLUSIONS_FILE:path.join(root,'exclusions.json'),WENTIAN_AGENT_REGISTRATIONS_FILE:path.join(root,'registrations.json'),WENTIAN_DEFAULT_MAINTENANCE_ACCESS:'true',WENTIAN_MAINTENANCE_CONTROLS_FILE:path.join(root,'controls.json')};
  const before=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
  t.after(()=>{for(const [key,value]of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  await writeFile(env.WENTIAN_AGENT_CONNECTION_CACHE,JSON.stringify({agents:{opencode:{model:'fixture-model',provider:'fixture',baseUrl:'https://fixture.invalid/v1',mode:'native'}}}));
  const app=Fastify();
  registerExecutionGovernance(app,{workspace:path.join(root,'project'),authorize:req=>req.headers.authorization==='browser-fixture',identity:req=>req.headers.authorization==='browser-fixture'?'browser-fixture':undefined});
  app.get('/api/control-center/me',async()=>({user:{username:'fixture',role:'admin'}}));
  app.get('/api/menu-policy',async()=>({}));
  await app.listen({host:'127.0.0.1',port:0});
  const origin=`http://127.0.0.1:${(app.server.address() as any).port}`,browser=await chromium.launch({headless:true});
  const evidence:any={mode:'isolated-http-and-real-browser',productionSettingsChanged:false,checks:[]};
  try{
    for(const language of ['ja','en','zh'])for(const width of [1440,390]){
      const context=await browser.newContext({viewport:{width,height:1000},extraHTTPHeaders:{authorization:'browser-fixture'}});
      await context.addInitScript(lang=>localStorage.setItem('wentian-language',lang),language);
      const page=await context.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(origin+'/execution-permissions?agent=opencode');await page.locator('#defaultAccessStatus').filter({hasText:language==='ja'?'期限なし':language==='en'?'no expiry':'无到期时间'}).waitFor();
      assert.equal(await page.locator('#executionAdvanced').getAttribute('open'),null);
      await page.locator('#grantProjectExecution').click();await page.locator('#projectExecutionGrants button').waitFor();
      const state=await (await context.request.get(origin+'/api/execution-permissions')).json();assert.equal(state.access.projects.length,1);assert.equal(state.access.projects[0].expiresAt,undefined);
      const dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,language:document.documentElement.lang}));
      assert.equal(dimensions.language,language);assert.ok(dimensions.scroll<=dimensions.width+1,JSON.stringify(dimensions));assert.deepEqual(errors,[]);
      // クリックでスクロールした状態の固定ヘッダーを、全ページ画像の途中へ写し込まないよう先頭へ戻します。
      await page.evaluate(()=>window.scrollTo(0,0));
      await page.screenshot({path:path.join(output,`execution-${language}-${width}.png`),fullPage:true});
      evidence.checks.push({...dimensions,projectCount:state.access.projects.length,noExpiry:true,errors});
      await context.close();
    }
    // 稼働サービス側は閲覧だけを行い、実際に配信されたAgent画面と既定状態を別証跡にします。
    if(process.env.WENTIAN_VISUAL_SERVER){
      const server=new URL(process.env.WENTIAN_VISUAL_SERVER).origin;
      const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();
      await page.goto(server+'/#agents');await page.locator('#maintenanceAccessStatus').filter({hasText:'期限なし'}).waitFor();
      await page.locator('#agentMaintenance').screenshot({path:path.join(output,'live-agent-maintenance.png')});
      const response=await context.request.get(server+'/v1/manager/external-agents/maintenance');const status=await response.json();
      assert.equal(status.executionAccess.maintenanceDefault,true);evidence.live={url:server,status:response.status(),executionAccess:status.executionAccess,screenText:await page.locator('#maintenanceAccessStatus').innerText(),authenticated:false};
      await context.close();
    }
    await writeFile(path.join(output,'result.json'),JSON.stringify(evidence,null,2)+'\n','utf8');
  }finally{await browser.close();await app.close();}
});
