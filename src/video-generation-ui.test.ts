import test from 'node:test';
import assert from 'node:assert/strict';
import { Window, HTMLButtonElement, HTMLSelectElement } from 'happy-dom';
import { videoGenerationHtml } from './video-generation-ui.js';

/** 実画面のスクリプトを実行し、音声取得失敗と動画生成可否が独立することを検証します。 */
async function page(audio: 'failed'|'empty'|'available', ready=true) {
 const window=new Window({url:'http://127.0.0.1:8787/videos'});
 window.setInterval=(()=>0) as any;
 window.fetch=(async(url:any)=>{
  const key=String(url);
  if(key==='/api/control-center/me')return {ok:true,json:async()=>({user:{role:'admin'}})};
  if(key==='/api/videos/readiness')return {ok:true,json:async()=>({ready,message:ready?'準備済み':'未準備',device:'cuda:0',lowMemory:true})};
  if(key==='/api/videos')return {ok:true,json:async()=>({jobs:[]})};
  if(key==='/api/media')return {ok:audio!=='failed',status:audio==='failed'?500:200,json:async()=>audio==='failed'?{error:{message:'音声一覧の試験エラー'}}:{jobs:audio==='empty'?[]:[{id:'audio-id',status:'succeeded',input:{mediaType:'audio',title:'ナレーション'}}]}};
  throw new Error('未定義の試験要求');
 }) as any;
 window.document.write(videoGenerationHtml.replace(/<script>[\s\S]*?<\/script>/g,''));
 // Happy DOMに未実装のブラウザー標準Optionコンストラクターだけを補います。
 window.eval("window.Option=function(text='',value=''){const option=document.createElement('option');option.textContent=text;option.value=value;return option;}");
 for(const script of videoGenerationHtml.matchAll(/<script>([\s\S]*?)<\/script>/g))window.eval(script[1]);
 for(let i=0;i<15;i++)await new Promise(resolve=>setTimeout(resolve,5));
 return window;
}

test('音声一覧が失敗しても準備済みの動画生成ボタンを有効にする',async()=>{
 const window=await page('failed');
 try{assert.equal((window.document.getElementById('generate') as HTMLButtonElement).disabled,false);assert.match(window.document.getElementById('audioStatus')!.textContent!,/無音の動画は生成できます/);assert.equal((window.document.getElementById('resolution') as HTMLSelectElement).value,'256x256');}
 finally{await window.happyDOM.close();}
});
test('完成音声を選択肢へ表示し、素材がない場合は作成方法を案内する',async()=>{
 for(const state of ['empty','available'] as const){const window=await page(state);try{const select=window.document.getElementById('soundtrack') as HTMLSelectElement;assert.equal(select.options.length,state==='empty'?1:2);if(state==='empty')assert.match(window.document.getElementById('audioStatus')!.textContent!,/完成済み音声がありません/);else assert.equal(select.options[1].textContent,'ナレーション');}finally{await window.happyDOM.close();}}
});
test('動画エンジンが未準備の場合は生成ボタンを有効化しない',async()=>{
 const window=await page('available',false);try{assert.equal((window.document.getElementById('generate') as HTMLButtonElement).disabled,true);}finally{await window.happyDOM.close();}
});
