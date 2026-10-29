import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { startupForgeMotionScript } from './startup-forge-motion-ui.js';

async function fixture(saved?: string) {
  const window = new Window({ url: 'http://localhost/startup-forge#groups' }), doc = window.document;
  doc.write('<div class="world-stage"><div id="worldActors"><button class="world-actor" data-name="AI" style="left:40%;top:60%"><span class="actor-tag">AI</span></button></div><div id="forgeHumans"><button class="forge-human" data-name="人間" data-user-id="human-id"><img><span class="actor-tag">人間</span></button></div></div><div id="worldScenes"></div>');
  const stage = doc.querySelector('.world-stage') as any; stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500 });
  for (const actor of doc.querySelectorAll('.world-actor,.forge-human')) (actor as any).getBoundingClientRect = () => ({ left: 350, top: 150, right: 450, bottom: 300, width: 100, height: 150 });
  let callback: FrameRequestCallback | undefined; (window as any).requestAnimationFrame = (cb: FrameRequestCallback) => { callback = cb; return 1; }; (window as any).cancelAnimationFrame = () => {};
  if (saved) window.localStorage.setItem('wentian-forge-motion:g1', saved);
  window.eval(startupForgeMotionScript.replace(/^<script>/, '').replace(/<\/script>$/, ''));
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(r => setImmediate(r)); };
  doc.dispatchEvent(new window.CustomEvent('wentian-forge-group', { detail: { id: 'g1' } })); await settle();
  // 捕捉中のクリックは捕捉先へ届くため、実ブラウザーと同じ宛先を模擬します。
  let captured: any;
  stage.setPointerCapture = () => { captured = stage; };
  stage.hasPointerCapture = () => captured === stage;
  stage.releasePointerCapture = () => { captured = undefined; };
  const doubleClick = (node: any) => {
    for (let detail = 1; detail <= 2; detail++) {
      pointer(node, 'pointerdown', 400, 300);
      const target = captured || node;
      pointer(target, 'pointerup', 400, 300);
      target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail }));
      if (detail === 2) target.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, detail }));
    }
  };
  const pointer = (node: any, type: string, x: number, y: number) => node.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x, clientY: y }));
  return { window, doc, stage, settle, pointer, doubleClick, frame: (time: number) => callback?.(time) };
}
test('既定でAIは固定し人間は歩き、ドラッグ位置を再描画後も維持する', async () => {
  const f = await fixture(); const ai = f.doc.querySelector('.world-actor') as any, human = f.doc.querySelector('.forge-human') as any;
  try { assert.equal((f.doc.getElementById('worldMovementEnabled') as any).checked, true); const before = ai.style.left, humanBefore = human.style.left; f.frame(1000); f.frame(1050); assert.equal(ai.style.left, before); assert.equal(ai.dataset.fixed, 'true'); assert.equal(ai.dataset.moving, 'false'); assert.notEqual(human.style.left, humanBefore); assert.equal(human.dataset.moving, 'true');
    f.pointer(ai, 'pointerdown', 400, 300); f.pointer(f.stage, 'pointermove', 700, 400); f.pointer(f.stage, 'pointerup', 700, 400);
    assert.equal(ai.dataset.fixed, 'true'); const fixed = ai.style.left; f.frame(1100); f.frame(1150); assert.equal(ai.style.left, fixed);
    const saved = JSON.parse(f.window.localStorage.getItem('wentian-forge-motion:g1')!); assert.ok(saved.pins['ai:AI'].x > 60);
    const replacement = ai.cloneNode(true) as any; replacement.getBoundingClientRect = ai.getBoundingClientRect; ai.replaceWith(replacement); await f.settle(); assert.equal(replacement.style.left, fixed); assert.equal(replacement.dataset.fixed, 'true');
    f.doubleClick(replacement); assert.equal(replacement.dataset.fixed, 'false'); assert.equal(JSON.parse(f.window.localStorage.getItem('wentian-forge-motion:g1')!).pins['ai:AI'], undefined);
  } finally { await f.window.happyDOM.close(); }
});
test('人間も画面内へドラッグでき、群を切り替えると別の位置設定になる', async () => {
  const f = await fixture(); const human = f.doc.querySelector('.forge-human') as any;
  try { f.pointer(human, 'pointerdown', 400, 300); f.pointer(f.stage, 'pointermove', -1000, 2000); f.pointer(f.stage, 'pointerup', -1000, 2000);
    assert.equal(human.dataset.fixed, 'true'); assert.ok(parseFloat(human.style.left) >= 5); assert.ok(parseFloat(human.style.top) <= 98);
    assert.ok(JSON.parse(f.window.localStorage.getItem('wentian-forge-motion:g1')!).pins['human:human-id']);
    f.doc.dispatchEvent(new f.window.CustomEvent('wentian-forge-group', { detail: { id: 'g2' } })); await f.settle(); assert.equal(human.dataset.fixed, 'false');
    f.doc.dispatchEvent(new f.window.CustomEvent('wentian-forge-group', { detail: { id: 'g1' } })); await f.settle(); assert.equal(human.dataset.fixed, 'true');
    (f.doc.getElementById('worldMovementReset') as any).click(); assert.equal(human.dataset.fixed, 'false');
  } finally { await f.window.happyDOM.close(); }
});
test('クリックだけでは固定せず、取消しを復元し、キーボードと停止設定を扱う', async () => {
  const f = await fixture(); const ai = f.doc.querySelector('.world-actor') as any;
  try { f.doubleClick(ai); f.pointer(ai, 'pointerdown', 400, 300); f.pointer(f.stage, 'pointerup', 400, 300); assert.equal(ai.dataset.fixed, 'false');
    const start = ai.style.left; f.pointer(ai, 'pointerdown', 400, 300); f.pointer(f.stage, 'pointermove', 600, 350); f.pointer(f.stage, 'pointercancel', 600, 350); assert.equal(ai.style.left, start); assert.equal(ai.dataset.fixed, 'false');
    ai.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); assert.equal(ai.dataset.fixed, 'true');
    const checkbox = f.doc.getElementById('worldMovementEnabled') as any; checkbox.checked = false; checkbox.dispatchEvent(new f.window.Event('change')); const human = f.doc.querySelector('.forge-human') as any, before = human.style.left; f.frame(1000); f.frame(1050); assert.equal(human.style.left, before); assert.equal(human.dataset.moving, 'false');
  } finally { await f.window.happyDOM.close(); }
});


test('全体停止中でもAIと人間のダブルクリックで固定解除と歩行を再開する', async () => {
  const f = await fixture(JSON.stringify({ enabled: false, pins: { 'ai:AI': {x:40,y:60}, 'human:human-id': {x:65,y:70} } }));
  try {
    let time = 1000;
    for (const selector of ['.world-actor', '.forge-human']) {
      const actor = f.doc.querySelector(selector) as any;
      assert.equal(actor.dataset.fixed, 'true');
      f.doubleClick(actor);
      assert.equal(actor.dataset.fixed, 'false');
      assert.equal(actor.dataset.moving, 'true');
      assert.equal((f.doc.getElementById('worldMovementEnabled') as any).checked, true);
      const before = actor.style.left; f.frame(time); f.frame(time + 50); time += 100; assert.notEqual(actor.style.left, before);
    }
  } finally { await f.window.happyDOM.close(); }
});

test('明示したAIの歩行再開を再読込後も保持し、ドラッグ固定を優先する', async () => {
  const f = await fixture(); let saved: string;
  try {
    f.doubleClick(f.doc.querySelector('.world-actor'));
    saved = f.window.localStorage.getItem('wentian-forge-motion:g1')!;
  } finally { await f.window.happyDOM.close(); }
  const restored = await fixture(saved);
  try {
    const ai = restored.doc.querySelector('.world-actor') as any;
    assert.equal(ai.dataset.moving, 'true');
    restored.pointer(ai, 'pointerdown', 400, 300); restored.pointer(restored.stage, 'pointermove', 600, 350); restored.pointer(restored.stage, 'pointerup', 600, 350);
    saved = restored.window.localStorage.getItem('wentian-forge-motion:g1')!;
  } finally { await restored.window.happyDOM.close(); }
  const pinned = await fixture(saved);
  try {
    assert.equal((pinned.doc.querySelector('.world-actor') as any).dataset.fixed, 'true');
    (pinned.doc.getElementById('worldMovementReset') as any).click();
    assert.equal((pinned.doc.querySelector('.world-actor') as any).dataset.moving, 'true');
  } finally { await pinned.window.happyDOM.close(); }
});
