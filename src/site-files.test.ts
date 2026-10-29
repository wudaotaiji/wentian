import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {SiteFiles,trashSite,listTrashedSites,purgeTrashedSite} from './site-files.js';
import {registerSiteAdmin,defaultPublicSite} from './public-site.js';

test('Apacheの原本を読み書きし、バックアップと競合・範囲外アクセスを検証する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-site-files-'));
 try {
  const apache=path.join(root,'apache');await mkdir(apache);await writeFile(path.join(apache,'index.html'),'<h1>原本</h1>');await writeFile(path.join(apache,'.env'),'SECRET');
  const files=new SiteFiles(root),connection=await files.connect(apache);assert.deepEqual(connection.files,['index.html']);
  const original=await files.read(connection.id,'index.html');
  const saved=await files.save(connection.id,'index.html','<h1>変更後</h1>',original.version);
  assert.equal(await readFile(path.join(apache,'index.html'),'utf8'),'<h1>変更後</h1>');
  assert.equal(await readFile(path.join(saved.backup,'index.html'),'utf8'),'<h1>原本</h1>');
  await assert.rejects(files.save(connection.id,'index.html','古い変更',original.version),/外部で変更/);
  await assert.rejects(files.read(connection.id,'../index.html'));await assert.rejects(files.read(connection.id,'.env'));
  await assert.rejects(files.read('unknown','index.html'),/失効/);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('5テンプレートを複製し、不要サイトを非公開・ゴミ箱へ移動する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-site-templates-')),app=Fastify();
 registerSiteAdmin(app,{workspace:root,authorize:()=>true,gatewayOrigin:()=> 'http://127.0.0.1:8787',design:async()=> '{}'});
 try {
  const templates=(await app.inject('/api/site-admin/templates')).json().templates;assert.equal(templates.length,5);
  for(const template of templates) {
   const response=await app.inject({method:'POST',url:'/api/site-admin/templates',payload:{template:template.id,slug:template.id,title:template.name}});
   assert.equal(response.statusCode,200,response.body);
   const data=response.json();assert.ok(data.source.files.includes('index.html'));
   assert.match(await readFile(path.join(data.source.directory,'index.html'),'utf8'),new RegExp(template.name));
  }
  const repeated=await app.inject({method:'POST',url:'/api/site-admin/templates',payload:{template:'aurora',slug:'aurora',title:'上書き禁止'}});assert.equal(repeated.statusCode,400);
  const deleted=(await app.inject({method:'POST',url:'/api/site-admin/delete?page=aurora',payload:{}})).json();
  assert.ok(deleted.trash);await access(path.join(deleted.trash,'manifest.json'));
  const pages=(await app.inject('/api/site-admin')).json().pages;assert.equal(pages.some((p:any)=>p.slug==='aurora'),false);assert.equal(pages.some((p:any)=>p.slug==='maison'),true);
  assert.equal((await app.inject({method:'POST',url:'/api/site-admin/delete?page=..%2Fescape',payload:{}})).statusCode,400);
  // トップは削除後に空の保存状態へ戻り、他の追加ページは維持します。
  await app.inject({method:'POST',url:'/api/site-admin',payload:defaultPublicSite});
  assert.equal((await app.inject({method:'POST',url:'/api/site-admin/delete',payload:{}})).statusCode,200);
 } finally {await app.close();await rm(root,{recursive:true,force:true});}
});

// 閉鎖（Close）と完全削除（Permanent Delete）を分離し、他サイトを保持します。
test('閉鎖済みだけを確認付きで完全削除し、公開トップの閉鎖も保持する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-site-purge-'));
 try{
  const {PublicSiteStore}=await import('./public-site.js');
  const store=new PublicSiteStore(root,'target'),other=new PublicSiteStore(root,'other');
  await store.save({...defaultPublicSite,title:'削除対象'});await other.save(defaultPublicSite);
  await trashSite(root,'target');const items=await listTrashedSites(root);
  assert.equal(items.length,1);assert.equal(items[0].title,'削除対象');
  assert.ok(!(await store.pages()).some(p=>p.slug==='target'));
  await assert.rejects(purgeTrashedSite(root,items[0].id,'違うID'));
  await assert.rejects(purgeTrashedSite(root,'../other','../other'));
  await purgeTrashedSite(root,items[0].id,items[0].id);
  assert.deepEqual(await listTrashedSites(root),[]);assert.equal((await other.load()).title,defaultPublicSite.title);
  await new PublicSiteStore(root).save(defaultPublicSite);await trashSite(root,'');
  assert.ok(!(await store.pages()).some(p=>p.slug===''));
 }finally{await rm(root,{recursive:true,force:true})}
});
