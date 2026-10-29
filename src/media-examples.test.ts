import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerMediaExamples } from './media-examples.js';

test('保存した制作例は認証後だけ取得でき、再生Rangeと形式を検査する',async()=>{
 const app=Fastify();registerMediaExamples(app,(req,reply)=>{if(req.headers['x-test-admin']==='yes')return 'owner';reply.code(401).send({error:{message:'ログインが必要です。'}})});const headers={'x-test-admin':'yes'};
 try{assert.equal((await app.inject('/api/media/examples')).statusCode,401);const listing=(await app.inject({url:'/api/media/examples',headers})).json();assert.equal(listing.examples.length,12);assert.equal((await app.inject('/api/media/examples/speech-ja/content')).statusCode,401);
 const partial=await app.inject({url:'/api/media/examples/speech-ja/content',headers:{...headers,range:'bytes=0-3'}});assert.equal(partial.statusCode,206);assert.equal(partial.rawPayload.toString(),'RIFF');assert.equal((await app.inject({url:'/api/media/examples/speech-ja/content?format=../../manifest',headers})).statusCode,404);
 const text=await app.inject({url:'/api/media/examples/production-text/content?download=1',headers});assert.match(text.body,/こんにちは/);assert.match(String(text.headers['content-disposition']),/attachment/);
 }finally{await app.close()}
});
