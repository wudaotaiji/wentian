/** 実Jupyterを一時ノートブック領域で起動し、Wentianの中継経由だけで検証します。 */
import Fastify from 'fastify';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { JupyterStudyService } from '../src/study/service.js';
import { registerStudy } from '../src/study/routes.js';

const root = path.resolve(process.env.WENTIAN_JUPYTER_MODULE_ROOT || '.wentian/modules/jupyter');
const notebooks = await mkdtemp(path.join(os.tmpdir(), 'wentian-study-verify-'));
const service = new JupyterStudyService(root, notebooks), app = Fastify();
// この検証サーバーだけの資格情報です。利用者のログイン情報は読み取りません。
const key = randomUUID();
registerStudy(app, service, (req, reply) => {
  if (req.headers['x-api-key'] === key) return true;
  reply.code(401).send({ error: { message: '検証用の認証が必要です。' } }); return false;
});
try {
  await app.listen({ host:'127.0.0.1',port:0 });
  const port = (app.server.address() as import('node:net').AddressInfo).port, base = `http://127.0.0.1:${port}`;
  const request = async (url: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + url, { method, headers: { 'x-api-key':key, ...(body ? {'content-type':'application/json'} : {}) }, ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(90000) });
    if (!response.ok) throw new Error(`接続試験に失敗しました: ${url} HTTP ${response.status}`);
    return response;
  };
  console.log('隔離領域でJupyterを起動します。');
  const state = await (await request('/api/study/start','POST',{})).json() as {version:string};
  const lab = await (await request('/study/jupyter/lab')).text();
  if (!lab.toLowerCase().includes('jupyter')) throw new Error('Lab画面がありません。');
  if (lab.includes(service.target()!.token)) throw new Error('Jupyterの認証情報が画面HTMLに含まれています。');
  if ((await fetch(base+'/study/jupyter/api/status')).status !== 401) throw new Error('未認証のアクセスが拒否されません。');
  const notebook = { type:'notebook', format:'json', content:{cells:[{cell_type:'code',execution_count:null,metadata:{},outputs:[],source:"print('WENTIAN_JUPYTER_OK')"}],metadata:{kernelspec:{display_name:'Python 3',language:'python',name:'python3'}},nbformat:4,nbformat_minor:5} };
  await request('/study/jupyter/api/contents/verification.ipynb','PUT',notebook);
  if (!(await readFile(path.join(notebooks,'verification.ipynb'),'utf8')).includes('WENTIAN_JUPYTER_OK')) throw new Error('ノートブックが保存されていません。');
  const kernel = await (await request('/study/jupyter/api/kernels','POST',{name:'python3'})).json() as {id:string};
  const output = await new Promise<string>((resolve,reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/study/jupyter/api/kernels/${kernel.id}/channels?session_id=${randomUUID()}`, {headers:{'x-api-key':key}});
    const timer = setTimeout(()=>{socket.terminate();reject(new Error('カーネル実行が時間切れです。'))},45000);
    socket.once('error',error=>{clearTimeout(timer);reject(error)});
    socket.once('open',()=>socket.send(JSON.stringify({header:{msg_id:randomUUID(),username:'verification',session:randomUUID(),msg_type:'execute_request',version:'5.3'},parent_header:{},metadata:{},content:{code:"print('WENTIAN_JUPYTER_OK')",silent:false,store_history:false,user_expressions:{},allow_stdin:false,stop_on_error:true},channel:'shell',buffers:[]})));
    socket.on('message',data=>{try{const message=JSON.parse(data.toString());if(message.msg_type==='stream'&&message.content?.text?.includes('WENTIAN_JUPYTER_OK')){clearTimeout(timer);resolve(message.content.text.trim());socket.close()}if(message.msg_type==='error'){clearTimeout(timer);reject(new Error('Pythonセル実行に失敗しました。'));socket.close()}}catch{}});
  });
  await request('/study/jupyter/api/kernels/'+kernel.id,'DELETE');
  await request('/api/study/stop','POST',{});
  await request('/api/study/start','POST',{});
  if (!(await readFile(path.join(notebooks,'verification.ipynb'),'utf8')).includes(output)) throw new Error('再起動後の保存内容が異なります。');
  console.log(JSON.stringify({version:state.version,lab:true,authentication:true,notebookSaved:true,websocketExecution:output,restartPersistence:true},null,2));
} finally { await app.close(); await rm(notebooks,{recursive:true,force:true,maxRetries:5,retryDelay:200}); }
