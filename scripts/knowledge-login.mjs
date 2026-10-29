/**
 * 知識庫収集用のログイン状態を利用者自身の操作で保存します。
 * 資格情報を引数やログへ出さず、保存先は明示指定した通常ファイルだけを使います。
 * Python版とPowerShell版の共通実行部です。既存の通常ブラウザーには接続しません。
 */
import { chromium } from 'playwright';
import { mkdir, chmod, stat, lstat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';

const args=process.argv.slice(2),value=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1]};
async function ordinary(file){for(let cursor=resolve(file);;cursor=dirname(cursor)){try{const info=await lstat(cursor);if(info.isSymbolicLink()||info.isFile()&&info.nlink>1)throw Error('リンク経由の保存先は使えません。')}catch(error){if(error.code!=='ENOENT')throw error}if(dirname(cursor)===cursor)break}}
let browser;
try{
  const url=new URL(value('--url')||'');if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('ログイン先のHTTP/HTTPS URLを指定してください。');
  const destination=resolve(value('--output')||'');if(!value('--output'))throw Error('保存先を明示してください。');await ordinary(destination);
  const exists=await stat(destination).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error});
  if(exists&&!args.includes('--replace'))throw Error('保存先が既にあります。更新する場合は--replaceを指定してください。');
  browser=await chromium.launch({headless:false,executablePath:value('--executable')||process.env.WENTIAN_KNOWLEDGE_BROWSER_EXECUTABLE||undefined});
  const context=await browser.newContext(),page=await context.newPage();await page.goto(url.href,{waitUntil:'domcontentloaded'});
  const input=createInterface({input:process.stdin,output:process.stdout});try{await input.question('開いたブラウザーでログインし、収集対象を表示できたらEnterを押してください。\n')}finally{input.close()}
  await ordinary(destination);await mkdir(dirname(destination),{recursive:true,mode:0o700});
  await writeFile(destination,JSON.stringify(await context.storageState({indexedDB:true})),{mode:0o600,flag:args.includes('--replace')?'w':'wx'});await chmod(destination,0o600);
  process.stdout.write('ログイン状態を保存しました。秘密ファイルとして管理し、公開しないでください。\n');
}catch{process.stderr.write('ログイン状態を保存できませんでした。URL、保存先、ブラウザーの準備と更新指定を確認してください。\n');process.exitCode=1}
finally{await browser?.close()}
