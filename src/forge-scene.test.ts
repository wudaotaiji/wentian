import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import { Window } from 'happy-dom';
import { saveForgeScene, loadForgeScene, validateForgeScene, type ForgeScene } from './forge-scene.js';
import { publicForgeScript, forgeSceneSharingScript } from './forge-scene-ui.js';
import { AgentGroupStore, namedMembers } from './agent-group.js';
import { buildPublicWebsite, PublicSiteStore, defaultPublicSite, renderPublicHome, registerSiteAdmin } from './public-site.js';

const scene: ForgeScene = { background: '/assets/startup-forge/beach.png', enabled: true, actors: [{ name: 'AI', image: '/assets/startup-forge/characters.png', sprite: 2, x: 30, y: 65, fixed: true }, { name: '人間', image: 'data:image/png;base64,aGVsbG8=', x: 65, y: 85, fixed: false }] };

test('同一ポートの公開ページも背景PNGを文字化けさせず配信する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-forge-image-')), app = (await import('fastify')).default();
  try {
    const groups = new AgentGroupStore(root), group = await groups.create('公開舞台', namedMembers(['AI']));
    await new PublicSiteStore(root, 'companyprofile').save({ ...defaultPublicSite });
    const id = '12345678-1234-4234-8234-123456789abc';
    const bytes = Buffer.from([137,80,78,71,13,10,26,10,0,128,255,254]);
    await mkdir(path.join(root,'.wentian','visual-assets'),{recursive:true});await writeFile(path.join(root,'.wentian','visual-assets',id+'.png'),bytes);
    await saveForgeScene(root,group.id,{...scene,background:'/api/visual-assets/'+id+'/content'});
    await groups.publish(group.id,true,'紹介','offline','companyprofile');
    registerSiteAdmin(app,{workspace:root,authorize:()=>true,gatewayOrigin:()=> 'http://localhost',design:async()=> '{}'});
    assert.equal((await app.inject('/sites/companyprofile/')).statusCode,200);
    const url=(await app.inject('/api/site?page=companyprofile')).json().rooms[0].scene.background;
    const response=await app.inject(url);assert.equal(response.statusCode,200);assert.deepEqual(response.rawPayload,bytes);
    await groups.publish(group.id,false,undefined,'offline','companyprofile');assert.equal((await app.inject(url)).statusCode,404);
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

test('舞台の入力を検証し、公開不要の識別情報や任意URLを保存しない', () => {
  const result = validateForgeScene({ ...scene, apiKey: '秘密', actors: [{ ...scene.actors[0], email: '秘密', userId: '秘密' }] });
  assert.doesNotMatch(JSON.stringify(result), /秘密|userId|email|apiKey/);
  assert.equal(validateForgeScene({ ...scene, background: '/assets/startup-forge/medical-lab.png', actors: [{ ...scene.actors[0], image: '/assets/startup-forge/medical-professor.png', sprite: undefined }] }).actors[0].image, '/assets/startup-forge/medical-professor.png');
  for (const background of ['https://example.com/image.png', '/api/private', 'javascript:alert(1)']) assert.throws(() => validateForgeScene({ ...scene, background }));
  assert.throws(() => validateForgeScene({ ...scene, actors: [{ ...scene.actors[0], x: NaN }] }));
  new Script(publicForgeScript); new Script(forgeSceneSharingScript.slice(8, -9));
});

test('ページ別公開で舞台・生成素材を共有し、閉鎖と削除で取得を拒否する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-forge-scene-'));
  const web = buildPublicWebsite(root, 'http://localhost');
  try {
    const groups = new AgentGroupStore(root), group = await groups.create('舞台公開', namedMembers(['mock']));
    await new PublicSiteStore(root).save({ ...defaultPublicSite });
    const asset = '12345678-1234-4234-8234-123456789abc';
    const value = { ...scene, background: '/api/visual-assets/' + asset + '/content' };
    await saveForgeScene(root, group.id, value);
    assert.deepEqual(await loadForgeScene(root, group.id), value);
    await mkdir(path.join(root, '.wentian', 'visual-assets'), { recursive: true });
    await writeFile(path.join(root, '.wentian', 'visual-assets', asset + '.png'), Buffer.from([137,80,78,71]));
    const assetURL = '/api/site/rooms/' + group.id + '/forge-assets/' + asset + '.png';
    assert.equal((await web.inject(assetURL)).statusCode, 404);
    await groups.publish(group.id, true, '紹介', 'offline', '');
    const data = (await web.inject('/api/site')).json();
    assert.equal(data.rooms[0].scene.actors[0].fixed, true);
    assert.equal(data.rooms[0].scene.actors[1].fixed, false);
    assert.match(data.rooms[0].scene.background, /forge-assets/);
    assert.equal((await web.inject(assetURL)).statusCode, 200);
    assert.equal((await web.inject(assetURL + '?page=other')).statusCode, 404);
    await groups.publish(group.id, false, undefined, 'offline', '');
    assert.equal((await web.inject('/api/site')).json().rooms.length, 0);
    assert.equal((await web.inject(assetURL)).statusCode, 404);
    await groups.publish(group.id, true, undefined, 'offline', '');
    await groups.archive(group.id);
    assert.equal((await web.inject(assetURL)).statusCode, 404);
  } finally { await web.close(); await rm(root, { recursive: true, force: true }); }
});

test('公開舞台は画像・最新吹き出し・歩行を表示し、固定人物と同じDOMを維持する', async () => {
  const window = new Window({ url: 'http://localhost' }), doc = window.document;
  let tick: ((time: number) => void) | undefined;
  (window as any).requestAnimationFrame = (cb: (time: number) => void) => { tick = cb; return 1; };
  try {
    doc.write('<article id="card"><div class="public-thread"></div></article>');
    window.eval(publicForgeScript);
    const card = doc.getElementById('card')!;
    (window as any).mountPublicForge(card, scene, [{ speaker: 'AI', content: '<b>発言</b>' }]);
    const stage = card.querySelector('.public-forge') as any; stage.getBoundingClientRect = () => ({ width: 1000, height: 450 });
    for (const actor of stage.children) actor.getBoundingClientRect = () => ({ width: 100, height: 150 });
    assert.equal(stage.children[0].querySelector('.public-forge-bubble').textContent, '<b>発言</b>');
    assert.equal(stage.querySelector('.public-forge-bubble b'), null);
    tick?.(1000); tick?.(1050);
    assert.equal(stage.children[0].style.left, '30%');
    assert.notEqual(stage.children[1].style.left, '65%');
    const actor = stage.children[0]; (window as any).mountPublicForge(card, scene, []); assert.equal(stage.children[0], actor);
    (window as any).mountPublicForge(card, undefined, []); assert.equal(card.querySelector('.public-forge'), null);
    const html = renderPublicHome(defaultPublicSite, [{ id: 'one', title: '舞台', summary: '', scene, messages: [{speaker:'AI',content:'</script><script>bad()</script>',at:''}] }], 'http://localhost');
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script[1]);
  } finally { await window.happyDOM.close(); }
});
