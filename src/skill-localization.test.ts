import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';
import { listSkills, loadSkill, loadSkillPresentation, parseSkill } from './skills.js';
import { workbenchHtml } from './workbench-ui.js';

const names=['incident-triage','project-overview','verified-delivery'];

test('同梱Skillの名前・説明・手順に三言語の表示を用意し、実行用原本を保持する',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'wentian-skill-languages-'));
 try{
  const skills=await listSkills(root,root);
  for(const name of names){
   const skill=skills.find(row=>row.name===name)!;
   const original=await readFile(skill.source,'utf8');
   assert.equal(await loadSkill(name,root,root),original);
   assert.equal(skill.sha256,parseSkill(original,skill.source).sha256);
   const detail=await loadSkillPresentation(name,root,root);
   assert.equal(detail.content,original);
   for(const locale of ['ja','en','zh'] as const){
    const display=detail.localizations[locale]!;
    assert.ok(display.title&&display.description&&display.content);
    assert.deepEqual(skill.localizations![locale],{title:display.title,description:display.description});
    if(locale==='en')assert.doesNotMatch(display.title+display.description+display.content,/[\u3040-\u30ff\u3400-\u9fff]/);
    if(locale==='zh')assert.doesNotMatch(display.title+display.description+display.content,/[\u3040-\u30ff]/);
   }
  }
  // 同名でも利用者定義へ同梱の翻訳を流用しません。不正な翻訳は原本へ戻します。
  const directory=path.join(root,'.wentian/skills/incident-triage');await mkdir(directory,{recursive:true});
  const custom='---\nname: incident-triage\ndescription: 利用者の手順\n---\n利用者が定義した本文。';
  await writeFile(path.join(directory,'SKILL.md'),custom);
  await writeFile(path.join(directory,'display.json'),'{"en":{"title":"Wrong type","description":1,"content":false}}');
  const customSkill=(await listSkills(root,root)).find(row=>row.name==='incident-triage')!;
  assert.equal(customSkill.localizations,undefined);
  assert.deepEqual(await loadSkillPresentation('incident-triage',root,root),{content:custom,localizations:{}});
  const display={title:'Custom title',description:'Custom description',content:'Custom instructions'};
  await writeFile(path.join(directory,'display.json'),JSON.stringify({en:display}));
  assert.deepEqual((await loadSkillPresentation('incident-triage',root,root)).localizations,{en:display});
  assert.equal(await loadSkill('incident-triage',root,root),custom);
  await assert.rejects(loadSkillPresentation('../incident-triage',root,root),/見つかりません/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('工作台のSkill一覧と開いた手順が三言語へ追従し、識別子と利用者定義を保持する',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'wentian-skill-ui-'));
 const window=new Window({url:'http://localhost/workbench#skills'});
 window.setInterval=(()=>0) as any;
 try{
  const skills=(await listSkills(root,root)).filter(row=>names.includes(row.name));
  const custom={name:'custom-skill',description:'利用者の説明',source:'',sha256:''};
  const snapshot={workspace:'test',goals:[],skills:[...skills,custom],sessions:[]};
  const details=Object.fromEntries(await Promise.all(names.map(async name=>[name,await loadSkillPresentation(name,root,root)])));
  const requested:string[]=[];
  window.fetch=(async(url:unknown)=>{
   const address=String(url);
   if(address.startsWith('/api/workbench/skills/')){requested.push(address);const name=decodeURIComponent(address.split('/').at(-1)!);return new window.Response(JSON.stringify(details[name]||{content:'利用者の原文',localizations:{}}));}
   if(address==='/api/workbench')return new window.Response(JSON.stringify(snapshot));
   if(address.endsWith('/me'))return new window.Response('{}',{status:401});
   return new window.Response(JSON.stringify({needsSetup:false}));
  }) as any;
  window.document.write(workbenchHtml.replace(/<script>[\s\S]*?<\/script>/g,''));
  const scripts=[...workbenchHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(row=>row[1]);
  window.eval(scripts.find(script=>script.includes('window.wentianUi={t,apply,language}'))!);
  window.eval(scripts.find(script=>script.includes('function render(){const goals=state.goals'))!+`\nstate=${JSON.stringify(snapshot)};render();`);
  const doc=window.document;
  // ナビゲーションの組立て以外は実画面コードを使い、共通言語セレクターを用意します。
  if(!doc.getElementById('language')){const selector=doc.createElement('select');selector.id='language';for(const locale of ['ja','en','zh']){const option=doc.createElement('option');option.value=locale;option.textContent=locale;selector.append(option)}doc.body.append(selector);}
  const settle=async()=>{for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));};
  await settle();
  for(const locale of ['ja','en','zh','ja'] as const){
   const selector=doc.getElementById('language') as any;selector.value=locale;selector.dispatchEvent(new window.Event('change',{bubbles:true}));await settle();
   // 開いている内容も、クリックやAPI再取得なしで切り替わります。
   if(requested.length){const previous=details['verified-delivery'].localizations[locale]!;assert.equal(doc.getElementById('skillContent')!.textContent,[previous.title,previous.description,previous.content].join('\n\n'));}
   for(const name of names){
    const button=doc.querySelector(`[data-skill-name="${name}"]`) as any;
    const display=details[name].localizations[locale]!;
    assert.equal(button.textContent,display.title);
    assert.equal(button.parentElement.querySelector('code').textContent,name);
    assert.equal(button.parentElement.querySelector('p').textContent,display.description);
    button.click();await settle();
    assert.equal(button.getAttribute('aria-pressed'),'true');
    assert.equal(requested.at(-1),'/api/workbench/skills/'+name);
    assert.equal(doc.getElementById('skillContent')!.textContent,[display.title,display.description,display.content].join('\n\n'));
   }
   assert.equal(doc.querySelector('[data-skill-name="custom-skill"]')!.textContent,'custom-skill');
   assert.equal(doc.querySelector('[data-skill-name="custom-skill"]')!.parentElement!.querySelector('p')!.textContent,'利用者の説明');
  }
 }finally{await window.happyDOM.close();await rm(root,{recursive:true,force:true});}
});
