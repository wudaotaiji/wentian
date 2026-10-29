import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { IntegrationPatrolClient } from './integration-patrol.js';

test('外部連携を未設定でも起動でき、呼び出し時に設定不足を通知する', async () => {
  const client = new IntegrationPatrolClient({baseUrl:'', timeoutMs:1000});
  await assert.rejects(client.run({systemPrompt:'規則',userRequest:'確認',catalog:'test',schema:'test',table:'test'}), /WENTIAN_INTEGRATION_BASE_URL/);
});

test('Workflow integrationへSystem PromptとUser Requestを所定フィールドで送る', async () => {
  let received:any;
  const server=createServer((request,response)=>{let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{received={headers:request.headers,body:JSON.parse(body)};response.setHeader('content-type','application/json');response.end(JSON.stringify({report:'ok'}))})});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();if(!address||typeof address==='string')throw new Error('試験サーバー起動失敗');
    const client=new IntegrationPatrolClient({baseUrl:`http://127.0.0.1:${address.port}`,session:'test-session',timeoutMs:3000});
    const result=await client.run({systemPrompt:'システム規則',userRequest:'利用者依頼',catalog:'iceberg',schema:'sales',table:'orders'});
    assert.deepEqual(result,{report:'ok'});assert.equal(received.body.systemPrompt,'システム規則');assert.equal(received.body.request,'利用者依頼');assert.equal(received.headers.origin,`http://127.0.0.1:${address.port}`);assert.equal(received.headers.cookie,'integration_session=test-session');
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
});

test('正式構成ではサービス認証と相関IDを送る', async () => {
  let received:any;
  const server=createServer((request,response)=>{let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{received={headers:request.headers,body:JSON.parse(body)};response.setHeader('content-type','application/json');response.end(JSON.stringify({report:'ok'}))})});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();if(!address||typeof address==='string')throw new Error('試験サーバー起動失敗');
    const client=new IntegrationPatrolClient({baseUrl:`http://127.0.0.1:${address.port}`,serviceToken:'service-token-for-test',serviceId:'wentian-gateway',timeoutMs:3000});
    await client.run({systemPrompt:'システム規則',userRequest:'利用者依頼',catalog:'iceberg',schema:'sales',table:'orders'});
    assert.equal(received.headers.authorization,'Bearer service-token-for-test');
    assert.equal(received.headers['x-integration-service-id'],'wentian-gateway');
    assert.match(received.headers['x-correlation-id'],/^[0-9a-f-]{36}$/);
    assert.equal(received.headers.cookie,undefined);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
});
