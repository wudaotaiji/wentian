import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { forgeChatScript } from './startup-forge-chat-ui.js';

test('左右の会話表示、全履歴・単発コピー、表示保持、コピー失敗時の代替を検証する',async()=>{
 const window=new Window({url:'http://localhost/startup-forge#groups'});
 try{
  window.document.write('<div class="world-chat"><div class="world-chat-heading"></div><div id="worldLog"></div></div>');
  (window as any).wentianGroupUser={id:'me'};
  const copied:string[]=[];Object.defineProperty(window.navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{copied.push(value);}}});
  window.eval(forgeChatScript.slice(8,-9));
  const group={id:'one',title:'研究グループ',members:[],messages:Array.from({length:15},(_,i)=>({userId:i===14?'me':'other',speaker:i===14?'本人':'担当',at:'2026-10-19T01:00:00Z',content:i===0?'<img src=x>最初の発言':'本文 '+i}))};
  const render=async(g:typeof group)=>{window.document.dispatchEvent(new window.CustomEvent('wentian-forge-group',{detail:g}));await new Promise<void>(r=>setImmediate(r));};
  await render(group);
  assert.equal(window.document.querySelectorAll('.forge-chat-row').length,15);assert.equal(window.document.querySelectorAll('.forge-chat-row.mine').length,1);assert.equal(window.document.querySelector('#worldLog img'),null);
  (window.document.getElementById('worldCopyConversation') as any).click();await new Promise<void>(r=>setImmediate(r));assert.match(copied[0],/研究グループ/);assert.match(copied[0],/最初の発言/);assert.match(copied[0],/本文 14/);
  (window.document.querySelector('.forge-chat-copy') as any).click();await new Promise<void>(r=>setImmediate(r));assert.match(copied[1],/最初の発言/);assert.doesNotMatch(copied[1],/本文 14/);
  const select=window.document.querySelector('select') as any;select.value='wechat';select.dispatchEvent(new window.Event('change'));await render(group);assert.equal(window.document.getElementById('worldLog')!.getAttribute('data-chat-style'),'wechat');assert.equal(window.localStorage.getItem('wentian-forge-chat-style'),'wechat');
  Object.defineProperty(window.navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('denied');}}});
  (window.document.getElementById('worldCopyConversation') as any).click();await new Promise<void>(r=>setImmediate(r));assert.equal((window.document.querySelector('.forge-chat-manual') as any).hidden,false);assert.match((window.document.querySelector('textarea') as any).value,/最初の発言/);
  await render({...group,id:'two',title:'別の群',messages:[]});assert.equal((window.document.querySelector('.forge-chat-manual') as any).hidden,true);assert.equal((window.document.querySelector('textarea') as any).value,'');assert.equal((window.document.getElementById('worldCopyConversation') as any).disabled,true);
 }finally{await window.happyDOM.close();}
});
