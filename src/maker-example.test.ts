import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { defaultPublicSite, validatePublicSite, renderPublicHome } from './public-site.js';
import { templateSite } from './site-templates.js';
import { makerLanguages } from './maker-example.js';

test('メーカー例の翻訳・言語リンク・デモ表示を保存検証後も保持する',()=>{
  const site=validatePublicSite(templateSite('maker-atelier',defaultPublicSite,'Maker <Atelier>'));
  const html=renderPublicHome(site,[],'http://localhost');
  assert.match(html,/<html lang="zh-CN"/);
  const window=new Window();window.document.write(html);
  const document=window.document;
  assert.equal(document.querySelectorAll('.maker-locale').length,5);
  for(const [lang,translation] of Object.entries(makerLanguages)){
    const article=document.getElementById('maker-'+lang)!;
    assert.equal(article.getAttribute('lang'),lang);
    assert.ok(article.textContent.includes(translation.demo));
    assert.ok(article.textContent.includes(translation.status));
    assert.equal(article.querySelectorAll('.maker-parts>div').length,8);
    assert.equal(document.querySelector(`[hreflang="${lang}"]`)?.getAttribute('href'),'#maker-'+lang);
    for(const link of article.querySelectorAll('a')){const href=link.getAttribute('href')!;if(href.startsWith('#'))assert.ok(document.getElementById(href.slice(1)));else assert.equal(href,'/commerce')}
  }
  assert.ok(site.customHtml.includes('Maker &lt;Atelier&gt;'));
  assert.ok(!site.customHtml.includes('<script'));
  assert.throws(()=>validatePublicSite({...site,language:'ja" onclick="bad'}));
  window.close();
});
