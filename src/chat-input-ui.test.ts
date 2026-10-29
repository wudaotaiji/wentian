import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { managerDashboardHtml } from './dashboard.js';

// マイク・認識サービス・実APIは使わず、ブラウザーの通知だけを模擬します。
function fixture(secure=true,supported=true){
 const window=new Window({url:secure?'http://localhost/#chat':'http://example.test/#chat'});
 Object.defineProperty(window,'isSecureContext',{value:secure});
 const recognizers:any[]=[];let resized:(()=>void)|undefined,submits=0;
 class Recognition{
  lang='';continuous=false;interimResults=false;starts=0;stops=0;aborts=0;
  onresult?:any;onerror?:any;onend?:any;
  constructor(){recognizers.push(this)}
  start(){this.starts++}stop(){this.stops++}abort(){this.aborts++;this.onend?.()}
 }
 if(supported)(window as any).SpeechRecognition=Recognition;
 (window as any).ResizeObserver=class{constructor(callback:()=>void){resized=callback}observe(){}};
 window.document.write(managerDashboardHtml.replace(/<script>[\s\S]*?<\/script>/g,''));
 const scripts=[...managerDashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(row=>row[1]);
 window.eval(scripts.find(source=>source.includes('window.wentianUi={t,apply,language}'))!);
 window.eval(scripts.find(source=>source.includes('const Recognition=window.SpeechRecognition'))!);
 const doc=window.document;
 doc.getElementById('chatForm')!.addEventListener('submit',()=>{submits++});
 const result=(recognizer:any,rows:Array<[string,boolean]>,index=0)=>recognizer.onresult({resultIndex:index,results:rows.map(([text,final])=>Object.assign([{transcript:text}],{isFinal:final}))});
 const language=(value:string)=>{window.localStorage.setItem('wentian-language',value);doc.dispatchEvent(new window.Event('wentian-language-changed'));(window as any).wentianUi.apply()};
 return{window,doc,recognizers,result,language,resize:()=>resized?.(),submits:()=>submits,settle:async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r))}};
}

test('会話欄の高さをスライダー・リセット・ドラッグで変更し、三言語で操作できる',async()=>{
 const f=fixture();try{
  const log=f.doc.getElementById('chatLog') as any,height=f.doc.getElementById('chatHeight') as any;
  assert.match(managerDashboardHtml,/#chatLog\{[^}]*resize:vertical/);
  height.value='600';height.dispatchEvent(new f.window.Event('input'));assert.equal(log.style.height,'600px');assert.equal(f.doc.getElementById('chatHeightValue')!.textContent,'600 px');
  (f.doc.getElementById('chatHeightReset') as any).click();assert.equal(log.style.height,'360px');
  log.getBoundingClientRect=(()=>({height:540})) as any;f.resize();assert.equal(height.value,'540');
  for(const [locale,label]of [['en','Conversation height'],['zh','会话框高度'],['ja','会話欄の高さ']]){f.language(locale);assert.equal(f.doc.querySelector('[for="chatHeight"]')!.textContent,label);}
 }finally{await f.window.happyDOM.close();}
});

test('音声の確定文だけを下書きへ追加し、途中結果・重複・手入力を保護して自動送信しない',async()=>{
 const f=fixture();try{
  f.language('zh');const input=f.doc.getElementById('chatInput') as any,voice=f.doc.getElementById('chatVoice') as any;
  input.value='draft ';input.setSelectionRange(6,6);voice.click();const recognition=f.recognizers[0];
  assert.equal(recognition.lang,'zh-CN');assert.equal(recognition.continuous,true);assert.equal(voice.getAttribute('aria-pressed'),'true');
  f.result(recognition,[['你好',false]]);assert.equal(input.value,'draft ');assert.equal(f.doc.getElementById('chatVoicePreview')!.textContent,'你好');
  f.result(recognition,[['你好',true]]);assert.equal(input.value,'draft 你好');f.result(recognition,[['你好',true]]);assert.equal(input.value,'draft 你好');
  input.value+=' manual';input.setSelectionRange(input.value.length,input.value.length);f.result(recognition,[['你好',true],['世界',true]],1);assert.equal(input.value,'draft 你好 manual 世界');
  assert.equal(f.submits(),0);voice.click();assert.equal(recognition.stops,1);recognition.onend();assert.equal(voice.getAttribute('aria-pressed'),'false');
  const previous=input.value;f.result(recognition,[['late text',true]],2);assert.equal(input.value,previous);
 }finally{await f.window.happyDOM.close();}
});

test('送信・新規会話・移動・言語変更で音声を停止し、遅れて届く認識結果を追加しない',async()=>{
 const f=fixture();try{
  const voice=f.doc.getElementById('chatVoice') as any,input=f.doc.getElementById('chatInput') as any;
  for(const action of [()=>f.doc.getElementById('chatForm')!.dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true})),()=> (f.doc.getElementById('chatNew') as any).click(),()=>f.language('en'),()=>f.window.dispatchEvent(new f.window.Event('pagehide'))]){
   voice.click();const recognition=f.recognizers.at(-1);action();assert.equal(recognition.aborts,1);f.result(recognition,[['late text',true]]);assert.equal(input.value,'');
  }
  voice.click();const recognition=f.recognizers.at(-1);(f.doc.getElementById('chatSend') as any).disabled=true;await f.settle();assert.equal(recognition.aborts,1);assert.equal(voice.disabled,true);
 }finally{await f.window.happyDOM.close();}
});

test('HTTP・非対応ブラウザー・権限拒否では状況を三言語で説明し、勝手に録音しない',async()=>{
 for(const [secure,supported]of [[false,true],[true,false],[true,true]]){
  const f=fixture(secure,supported);try{
   const voice=f.doc.getElementById('chatVoice') as any;
   for(const locale of ['ja','en','zh']){
    f.language(locale);voice.click();const status=f.doc.getElementById('chatVoiceStatus')!;
    if(!secure){assert.equal(f.recognizers.length,0);assert.ok(status.textContent!.includes('HTTPS'));assert.ok(status.textContent!.includes('Win+H'));}
    else if(!supported)assert.equal(f.recognizers.length,0);
    else{const recognition=f.recognizers.at(-1);assert.equal(recognition.lang,({ja:'ja-JP',en:'en-US',zh:'zh-CN'} as any)[locale]);recognition.onerror({error:'not-allowed'});assert.equal(recognition.aborts,1);assert.equal(voice.getAttribute('aria-pressed'),'false');}
    if(locale==='en')assert.doesNotMatch(status.textContent!,/[\u3040-\u30ff\u3400-\u9fff]/);
    if(locale==='zh')assert.doesNotMatch(status.textContent!,/[\u3040-\u30ff]/);
   }
  }finally{await f.window.happyDOM.close();}
 }
});
