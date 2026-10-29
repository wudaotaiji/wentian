// 匿名オンライン導入後のsetupと初期管理者作成を、隔離データで検証します。
import {spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{'install-root':{type:'string'},output:{type:'string'}}});
if(!values['install-root'])throw new Error('導入先を --install-root で指定してください。');
const installRoot=path.resolve(values['install-root']);
const require=createRequire(path.join(installRoot,'package.json'));
const {chromium}=require('playwright');
const output=values.output?path.resolve(values.output):await mkdtemp(path.join(tmpdir(),'wentian-public-setup-'));
await mkdir(output,{recursive:true});
const env={...process.env};
// 利用者の稼働設定・認証値を試験プロセスへ引き継ぎません。
for(const name of Object.keys(env))if(name.startsWith('WENTIAN_'))delete env[name];
Object.assign(env,{WENTIAN_INSTALL_ROOT:installRoot,WENTIAN_TASK_WORKSPACE:path.join(output,'workspace'),WENTIAN_USER_STORE:path.join(output,'users.json'),WENTIAN_CONFIG_DIR:path.join(output,'config'),WENTIAN_PUBLIC_PORT:'0',WENTIAN_AGENT_CONNECTION_MAINTENANCE:'false',WENTIAN_AGENT_MAINTENANCE_ENABLED:'false',WENTIAN_DEFAULT_MAINTENANCE_ACCESS:'false',WENTIAN_CLI_SETTINGS_FILE:path.join(output,'cli-settings.json')});
const child=spawn(process.execPath,[path.join(installRoot,'bin/wentian.js'),'setup','--port','auto','--no-open'],{cwd:output,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='',browser;child.stdout.on('data',chunk=>{log+=chunk.toString()});child.stderr.on('data',chunk=>{log+=chunk.toString()});
try{
 let url;
 for(let attempt=0;attempt<120;attempt++){
  url=log.match(/Wentian Web[^\n]*?(http:\/\/127\.0\.0\.1:\d+\/workbench)/)?.[1];
  if(url)break;
  if(child.exitCode!==null)throw new Error('setupプロセスが終了しました。');
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 if(!url)throw new Error('setupのURLが取得できません。');
 browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext(),page=await context.newPage();
 await page.goto(url);await page.waitForSelector('#loginForm',{state:'visible'});
 const status=await context.request.get(new URL('/api/control-center/status',url).href);
 if(!(await status.json()).needsSetup)throw new Error('隔離した初期状態になっていません。');
 const password=randomBytes(24).toString('base64url');
 await page.fill('#username','installation-admin');await page.fill('#password',password);await page.locator('#loginForm button').click();
 await page.waitForSelector('#app',{state:'visible'});const me=await context.request.get(new URL('/api/control-center/me',url).href);
 if(me.status()!==200||(await me.json()).user.role!=='admin')throw new Error('初期管理者の作成・ログインに失敗しました。');
 await page.goto(new URL('/#users',url).href);await page.waitForSelector('#userAdminPanel',{state:'visible'});
 await page.screenshot({path:path.join(output,'setup-account.png'),fullPage:true});
 await context.request.post(new URL('/api/control-center/logout',url).href);
 const result={success:true,setupStarted:true,initialAdminCreated:true,browserLogin:true,accountPage:true,modelResponseVerified:false};
 await writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
 await browser?.close();
 if(child.exitCode===null&&child.pid){if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill('SIGTERM');}
 await writeFile(path.join(output,'setup.log'),log);
}
