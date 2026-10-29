import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { Window, HTMLButtonElement, HTMLTextAreaElement } from 'happy-dom';
import { provisionMailSite } from './mail-site.js';
import { registerMailSolutions } from './mail-solutions.js';
import { registerSiteAdmin, defaultPublicSite, buildPublicWebsite } from './public-site.js';
import { withSiteEditor } from './site-editor-ui.js';

test('メールサイトの登録・認証・原本保存・閉鎖・完全削除を検証する', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'wentian-mail-site-'));
  const app=Fastify();
  const authorize=(req:any,reply:any)=>{if(req.headers.authorization==='Bearer admin')return true;reply.code(403).send({error:{message:'管理者のみ'}});return false;};
  try {
    await provisionMailSite(root);
    registerMailSolutions(app,authorize);
    registerSiteAdmin(app,{workspace:root,authorize,gatewayOrigin:()=> 'http://127.0.0.1:8787',design:async()=> '{}'});
    const headers={authorization:'Bearer admin'}, url='/api/site-admin?page=mail-solutions';
    const data=(await app.inject({url,headers})).json();
    assert.equal(data.pages.filter((p:any)=>p.slug==='mail-solutions').length,1);
    assert.equal(data.site.title,'Wentian Mail Solutions');
    assert.match(data.site.mailDocument, /id="language"/);
    assert.equal((await app.inject('/sites/mail-solutions/')).statusCode,403);
    assert.equal((await app.inject({url:'/mail-solutions',headers})).headers.location,'/sites/mail-solutions/');
    assert.equal((await app.inject('/sites/mail-solutions')).headers.location,'/sites/mail-solutions/');
    const document=data.site.mailDocument.replace('Wentian Enterprise','編集済みメールサイト');
    const payload={...data.site,mailDocument:document};
    const saved=await app.inject({method:'POST',url,headers,payload});
    assert.equal(saved.statusCode,200);
    assert.ok(saved.json().source);
    assert.equal((await app.inject({method:'POST',url,headers,payload})).statusCode,409);
    const shown=await app.inject({url:'/sites/mail-solutions/',headers});
    assert.equal(shown.statusCode,200);assert.match(shown.body,/編集済みメールサイト/);
    assert.match(shown.body,/mail-train-panel/);assert.match(shown.body,/<script>/);
    const exported=await readFile(path.join(saved.json().source.directory,'index.html'),'utf8');
    assert.match(exported,/<script>/);assert.match(exported,/編集済みメールサイト/);
    const preview=await app.inject({method:'POST',url:'/api/site-admin/preview?page=mail-solutions',headers,payload:saved.json().site});
    assert.match(preview.headers['content-security-policy']!,/^sandbox;/);
    assert.equal((await app.inject({method:'POST',url:'/api/site-admin?page=other',headers,payload:{...payload,revision:0}})).statusCode,400);
    // 公開専用ポートとAPI（Application Programming Interface）から原本を取得できないことを確認します。
    const publicApp=buildPublicWebsite(root,'http://127.0.0.1:8787');
    try {assert.equal((await publicApp.inject('/pages/mail-solutions')).statusCode,404);assert.equal((await publicApp.inject('/api/site?page=mail-solutions')).statusCode,404);}
    finally {await publicApp.close();}
    assert.equal((await app.inject({method:'POST',url:'/api/site-admin/delete?page=mail-solutions',headers,payload:{}})).statusCode,200);
    assert.equal((await app.inject({url:'/sites/mail-solutions/',headers})).statusCode,404);
    await provisionMailSite(root);
    assert.equal((await app.inject({url,headers})).json().pages.some((p:any)=>p.slug==='mail-solutions'),false);
    const trash=(await app.inject({url:'/api/site-admin/trash',headers})).json().items;
    assert.equal(trash[0].page,'mail-solutions');
    assert.equal((await app.inject({method:'POST',url:'/api/site-admin/trash/purge',headers,payload:{id:trash[0].id,confirmation:trash[0].id}})).statusCode,200);
    await provisionMailSite(root);
    assert.equal((await app.inject({url:'/sites/mail-solutions/',headers})).statusCode,404);
  } finally {await app.close();await rm(root,{recursive:true,force:true});}
});

test('メールサイトの一覧リンク・編集・保存・閉鎖の画面操作を検証する',async()=>{
  const window=new Window({url:'http://127.0.0.1:8787/#site-list'});
  let saved={...structuredClone(defaultPublicSite),title:'Wentian Mail Solutions',mailDocument:'<!doctype html><html><body>原本</body></html>'};
  let closed=false;const calls:string[]=[];
  window.fetch=(async(url:unknown,options:any={})=>{
    const parsed=new URL(String(url),window.location.href),address=parsed.pathname;
    let body:any={};
    if(address.endsWith('/me'))body={user:{role:'admin'}};
    if(address==='/api/site-admin'){
      if(options.body){saved={...JSON.parse(options.body),revision:saved.revision+1};calls.push('save');}
      body={site:parsed.searchParams.get('page')==='mail-solutions'?saved:defaultPublicSite,pages:closed?[]:[{slug:'mail-solutions',title:saved.title}]};
    }
    if(address==='/api/site-admin/preview')return new window.Response(JSON.parse(options.body).mailDocument||'<html></html>');
    if(address==='/api/site-admin/trash')body={items:[]};
    if(address==='/api/site-admin/delete'){closed=true;calls.push(parsed.searchParams.get('page')!);}
    return new window.Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
  }) as typeof window.fetch;
  Object.defineProperty(window,'confirm',{value:()=>true});
  const settle=async()=>{for(let i=0;i<30;i++)await new Promise<void>(resolve=>setImmediate(resolve));};
  try {
    const html=withSiteEditor('<html><head></head><body><main></main></body></html>');
    window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g,''));
    for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))window.eval(match[1]);
    await settle();const doc=window.document;
    const link=doc.querySelector('#siteList a')!;
    assert.equal(link.getAttribute('href'),'/sites/mail-solutions/');
    assert.equal(doc.getElementById('mailSolutionsManaged'),null);
    const buttons=link.parentElement!.querySelectorAll('button');
    assert.deepEqual([...buttons].map(b=>b.textContent),['編集','このサイト削除']);
    (buttons[0] as HTMLButtonElement).click();await settle();
    assert.equal(window.location.hash,'#site');
    assert.equal(doc.getElementById('siteDocumentEditor')!.hasAttribute('hidden'),false);
    const source=doc.getElementById('siteDocumentHtml') as HTMLTextAreaElement;
    source.value='<!doctype html><html><body>編集後</body></html>';
    (doc.getElementById('siteSave') as HTMLButtonElement).click();await settle();
    assert.ok(calls.includes('save'));assert.match(saved.mailDocument,/編集後/);
    assert.match((doc.getElementById('siteFrame') as any).srcdoc,/編集後/);
    (doc.querySelectorAll('#siteList button')[1] as HTMLButtonElement).click();await settle();
    assert.equal(calls.at(-1),'mail-solutions');assert.equal(doc.querySelector('#siteList a'),null);
  }finally{await window.happyDOM.close();}
});
