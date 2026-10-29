// 実配信画面と隔離EVMを接続し、実資金や利用者の秘密鍵を使用せず検証します。
import {createRequire} from 'node:module';
import {mkdir,writeFile,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const {values}=parseArgs({options:{'wtc-project':{type:'string'},server:{type:'string',default:'http://127.0.0.1:8787'},output:{type:'string'}}});
if(!values['wtc-project'])throw new Error('WTCプロジェクトの保存先を --wtc-project で指定してください。');
const wtcRoot=path.resolve(values['wtc-project']);
const {compile}=await import(pathToFileURL(path.join(wtcRoot,'scripts/compile.mjs')).href);
const require=createRequire(path.join(wtcRoot,'package.json'));
const ganache=require('ganache');
const {BrowserProvider,ContractFactory,parseEther}=require('ethers');
const rpc=ganache.provider({logging:{quiet:true},wallet:{totalAccounts:3},chain:{hardfork:'shanghai',chainId:1337}});
let browser;
const folder=values.output||await mkdtemp(path.join(tmpdir(),'wentian-wallet-')); await mkdir(folder,{recursive:true});
try{
 const provider=new BrowserProvider(rpc);provider.pollingInterval=50;
 const owner=await provider.getSigner(0),recipient=await provider.getSigner(1);const artifact=compile();
 const token=await new ContractFactory(artifact.abi,artifact.bytecode,owner).deploy(await owner.getAddress(),parseEther('1000'),86400);await token.waitForDeployment();
 await(await token.grantRole(await token.MINTER_ROLE(),await owner.getAddress())).wait();
 await(await token.mint(await owner.getAddress(),parseEther('100'))).wait();
 browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:960}});const page=await context.newPage();const errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.exposeFunction('testEthereumRequest',async request=>rpc.request({method:request.method==='eth_requestAccounts'?'eth_accounts':request.method,params:request.params||[]}));
 await page.addInitScript(()=>{const events={};window.ethereum={request:request=>window.testEthereumRequest(request),on:(event,fn)=>(events[event]??=[]).push(fn),removeListener:(event,fn)=>{events[event]=(events[event]||[]).filter(value=>value!==fn)}};window.testWalletEvent=(event,...args)=>(events[event]||[]).forEach(fn=>fn(...args));});
 const response=await page.goto(new URL('/wallet',values.server).href);assert.equal(response.status(),200);await page.waitForFunction(()=>document.querySelector('h1')?.textContent);
 const checks=[];
 for(const [language,title]of [['ja','ウォレット'],['en','Wallet'],['zh','钱包']]){
   await page.selectOption('#language',language);await page.waitForFunction(title=>document.querySelector('h1').textContent===title,title);
   await page.screenshot({path:folder+'/'+language+'.png',fullPage:true});checks.push({language,title:await page.locator('h1').textContent()});
 }
 await page.fill('#chain','1337');await page.fill('#token',await token.getAddress());await page.click('#connect');await page.waitForFunction(()=>document.querySelector('#account').textContent.includes('chainId: 1337'));
 await page.click('#balance');await page.waitForFunction(()=>document.querySelector('#account').textContent.includes('100 ERC-20'));
 await page.fill('#recipient',await recipient.getAddress());await page.fill('#amount','2.5');await page.click('#prepare');await page.waitForFunction(()=>!document.querySelector('#send').disabled);
 const preview=await page.locator('#preview').textContent();assert.ok(preview.includes('2.5'));assert.ok(preview.includes('1337'));assert.ok(preview.includes('手续费'));assert.ok(!preview.includes('???'));
 for(const [language,label]of [['ja','概算手数料'],['en','Estimated fee'],['zh','估算手续费']]){await page.selectOption('#language',language);await page.waitForFunction(label=>document.querySelector('#preview').textContent.includes(label),label);}
 await page.screenshot({path:folder+'/preview.png',fullPage:true});
 await page.click('#send');await page.waitForFunction(()=>document.querySelector('#transaction').textContent.includes('已提交'));
 await page.fill('#minimum','1');await page.click('#observe');await page.waitForFunction(()=>document.querySelector('#transaction').textContent.includes('已达到所需确认数'));
 assert.equal(await token.balanceOf(await recipient.getAddress()),parseEther('2.5'));
 await page.screenshot({path:folder+'/confirmed.png',fullPage:true});
 await page.click('#prepare');await page.waitForFunction(()=>!document.querySelector('#send').disabled);
 await page.evaluate(()=>window.testWalletEvent('accountsChanged',[]));assert.equal(await page.locator('#send').isDisabled(),true);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:folder+'/mobile.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 assert.deepEqual(errors,[]);await writeFile(folder+'/result.json',JSON.stringify({success:true,checks,token:await token.getAddress(),chainId:1337,transfer:'2.5',receiptVerified:true,eventsInvalidate:true,mobile:true,pageErrors:errors},null,2));
 console.log('三言語・実配信ページ・隔離WTC送金・確認数・イベント失効の検証が成功しました。');
}finally{await browser?.close();await rpc.disconnect();}
