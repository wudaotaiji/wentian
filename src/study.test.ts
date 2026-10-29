import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import WebSocket, { WebSocketServer } from 'ws';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import { registerStudy } from './study/routes.js';
import { studyHtml } from './study/ui.js';
import { checkedRelease, JupyterStudyService, type StudyModule } from './study/service.js';
import { WentianPluginKernel } from './plugin-kernel.js';
import { STUDY_JUPYTER_SERVICE, studyJupyterPlugin } from './study/plugin.js';
import { navigationRail } from './navigation-ui.js';

test('書房をメニューへ埋め込み、JupyterはPlugin登録だけで起動しない', async () => {
  for (const wb of [true,false]) { assert.match(navigationRail(wb), /href="\/study">書斎/); assert.doesNotMatch(navigationRail(wb), /href="https:\/\/jupyter.org/); }
  for (const script of studyHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script[1]);
  const root = await mkdtemp(path.join(os.tmpdir(), 'study-plugin-'));
  const kernel = new WentianPluginKernel();
  try {
    kernel.register(studyJupyterPlugin);
    await kernel.load([{ id: studyJupyterPlugin.id, config: { root, notebooks: path.join(root,'notebooks') } }]);
    const service = kernel.resolve(STUDY_JUPYTER_SERVICE).create(root);
    assert.equal((await service.status()).state, 'not-installed');
    assert.equal(service.target(), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('未知の接続契約・版・パストラバーサルを拒否し、未導入でもWentianを停止しない', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'study-release-'));
  try {
    assert.throws(() => checkedRelease({ contract:'other',release:'../../secret',version:'4.6.4' }));
    const service = new JupyterStudyService(root, path.join(root,'notebooks'));
    await assert.rejects(service.start(), /導入/);
    assert.equal((await service.status()).state, 'not-installed');
    await writeFile(path.join(root,'active.json'), JSON.stringify({contract:'bad'}));
    assert.equal((await service.status()).state, 'error');
  } finally { await rm(root, { recursive:true,force:true }); }
});

test('書房のHTTPとWebSocketは管理者認証と同一オリジンを通し、トークンをブラウザーへ返さない', async () => {
  const token = 'server-only-secret'; let started = false, observedAuth = '', observedCookie: unknown;
  const backend = createServer((req,res) => { observedAuth = req.headers.authorization || ''; observedCookie = req.headers.cookie;
    if(req.url?.endsWith('/lab')){res.setHeader('content-type','text/html');res.setHeader('content-security-policy',"object-src 'none'; frame-ancestors 'none'");res.end('<html><script type="application/json">{"token":"'+token+'"}</script></html>');return;}
    res.setHeader('content-type','application/json'); res.end(JSON.stringify({ path:req.url, method:req.method })); });
  const ws = new WebSocketServer({server:backend});
  ws.on('connection', (socket,req) => { observedAuth = req.headers.authorization || ''; socket.on('message',(value,binary) => socket.send(value,{binary})); });
  await new Promise<void>(resolve => backend.listen(0,'127.0.0.1',resolve));
  const port = (backend.address() as import('node:net').AddressInfo).port;
  const service: StudyModule = { status:async()=>({state:started?'running':'stopped',notebooks:'test'}),start:async()=>{started=true;return{state:'running',notebooks:'test'}},stop:async()=>{started=false;return{state:'stopped',notebooks:'test'}},restart:async()=>({state:'running',notebooks:'test'}),target:()=>started?{port,token}:undefined };
  const app = Fastify();
  registerStudy(app,service,(req,reply)=>{if(req.headers.cookie==='wentian_session=admin')return true;reply.code(401).send({error:{message:'管理者ログインが必要です。'}});return false;});
  try {
    assert.equal((await app.inject('/api/study/status')).statusCode,401);
    assert.equal((await app.inject('/study/jupyter/api/status')).statusCode,401);
    const headers = {cookie:'wentian_session=admin'};
    const documentUrl = '/study/jupyter/lab/tree/artifacts/forge/example/outcome.md';
    const launch = await app.inject({url:documentUrl,headers});
    assert.equal(launch.statusCode,302);
    assert.equal(launch.headers.location,'/study?open='+encodeURIComponent(documentUrl));
    assert.equal(started,false);
    assert.equal((await app.inject({url:'/study/jupyter/api/status',headers})).statusCode,503);
    assert.equal((await app.inject({method:'POST',url:'/api/study/start',headers:{...headers,origin:'https://other.example'},payload:{}})).statusCode,403);
    assert.equal(started,false);
    assert.equal((await app.inject({method:'POST',url:'/api/study/start',headers,payload:{}})).statusCode,200);
    const proxied = await app.inject({method:'POST',url:'/study/jupyter/api/contents',headers,payload:{type:'notebook'}});
    assert.equal(proxied.statusCode,200); assert.equal(proxied.json().path,'/study/jupyter/api/contents');
    assert.equal(observedAuth,'token '+token); assert.equal(observedCookie,undefined); assert.doesNotMatch(proxied.body, /server-only-secret/);
    const lab=await app.inject({url:'/study/jupyter/lab',headers});assert.doesNotMatch(lab.body,/server-only-secret/);assert.match(String(lab.headers['content-security-policy']),/object-src 'none'/);assert.match(String(lab.headers['content-security-policy']),/frame-ancestors 'self'/);
    await app.listen({host:'127.0.0.1',port:0});
    const address = app.server.address() as import('node:net').AddressInfo;
    const echo = await new Promise<string>((resolve,reject)=>{const socket=new WebSocket(`ws://127.0.0.1:${address.port}/study/jupyter/api/kernels/test/channels`,['v1.kernel.websocket.jupyter.org'],{headers});socket.once('open',()=>{assert.equal(socket.protocol,'v1.kernel.websocket.jupyter.org');socket.send(Buffer.from('kernel-message'))});socket.once('message',(data,binary)=>{assert.equal(binary,true);resolve(data.toString());socket.close()});socket.once('error',reject)});
    assert.equal(echo,'kernel-message');
    const denied = await new Promise<number>((resolve,reject)=>{const socket=new WebSocket(`ws://127.0.0.1:${address.port}/study/jupyter/api/kernels/test/channels`);socket.on('unexpected-response',(_req,res)=>{resolve(res.statusCode||0);res.resume();socket.terminate()});socket.on('error',()=>resolve(401));setTimeout(()=>reject(new Error('認証拒否の検証が時間切れです。')),3000).unref()});
    assert.equal(denied,401);
  } finally { await app.close(); ws.close(); await new Promise<void>(resolve=>backend.close(()=>resolve())); }
});
