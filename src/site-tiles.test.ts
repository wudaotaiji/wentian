import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultPublicSite, PublicSiteStore, registerSiteAdmin, renderPublicHome, validatePublicSite } from './public-site.js';
import { effectiveTiles, tileIds, validateTile } from './site-tiles.js';

test('トップの各部分をタイルで表示し、座標・サイズ・HTML・CSSを反映する', () => {
  const site = validatePublicSite(structuredClone(defaultPublicSite));
  const tiles = effectiveTiles(site);
  assert.equal(tileIds(site).length, 8);
  site.tiles = { hero: { ...tiles.hero, width: 900, height: 340, x: 100, html: '<h1>変更したコード</h1><script>bad()</script>', css: 'background: #ddedff; padding: 32px;' } };
  const validated = validatePublicSite(site);
  const html = renderPublicHome(validated, [], 'http://127.0.0.1:8787', true);
  assert.match(html, /data-site-tile="hero" data-x="100"/);
  assert.match(html, /変更したコード/);
  assert.doesNotMatch(html, /bad\(\)/);
  assert.match(html, /background: #ddedff/);
  assert.match(html, /tile-editor-preview/);
  for (const id of tileIds(site)) assert.ok(html.includes('data-site-tile="' + id + '"'));
  assert.throws(() => validateTile({ ...tiles.hero, x: 1100, width: 900 }), /大きさ/);
  assert.throws(() => validateTile({ ...tiles.hero, css: '}body{display:none}' }), /CSS/);
});

test('AI共同デザインは選択タイルのコードだけ変更して公開し、他のタイルを保持する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-tiles-'));
  const store = new PublicSiteStore(root), app = Fastify();
  const initial = validatePublicSite(structuredClone(defaultPublicSite));
  initial.tiles = { 'section-0': { ...effectiveTiles(initial)['section-0'], html: '<h3>保持するコード</h3>', css: 'color: blue;' } };
  let draft = await store.save(initial);
  registerSiteAdmin(app, { workspace: root, authorize: () => true, gatewayOrigin: () => 'http://127.0.0.1:8787', design: async (_model, messages) => {
    assert.match(messages.at(-1)!.content, /選択タイル: hero/);
    return JSON.stringify({ message: '選択タイルを青い紹介に変更しました。', tile: { ...effectiveTiles(draft).hero, html: '<h1>AIと共同制作した紹介</h1>', css: 'background: #dbeafe;' }, site: { title: '変更を禁止する値' } });
  } });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/site-admin/design', payload: { tileId: 'hero', prompt: '青い紹介にする', draft } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().saved, true);
    const saved = await store.load();
    assert.equal(saved.title, draft.title);
    assert.deepEqual(saved.tiles!['section-0'], draft.tiles!['section-0']);
    assert.equal(saved.tiles!.hero.html, '<h1>AIと共同制作した紹介</h1>');
    assert.match(renderPublicHome(saved, [], 'http://127.0.0.1:8787'), /AIと共同制作した紹介/);
    draft = saved;
    const invalid = await app.inject({ method: 'POST', url: '/api/site-admin/design', payload: { tileId: 'unknown', prompt: '変更', draft } });
    assert.equal(invalid.statusCode, 400);
    const preview = await app.inject({ method: 'POST', url: '/api/site-admin/design', payload: { tileId: 'hero', prompt: '青い紹介にする', draft, autoSave: false } });
    assert.equal(preview.json().saved, false);
    assert.equal((await store.load()).revision, draft.revision);
    const roomSite = validatePublicSite({ ...saved, tiles: { ...saved.tiles, rooms: { ...effectiveTiles(saved).rooms, html: '<h2>相談室の紹介</h2>' } } });
    assert.match(renderPublicHome(roomSite, [{ id: 'room', title: '公開相談室', summary: '本文を保持' }], 'http://127.0.0.1:8787'), /data-room="room"/);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
