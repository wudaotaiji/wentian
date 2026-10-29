import type { PublicSite } from './public-site.js';
import { makerExampleSite } from './maker-example.js';

/** ネット接続や外部素材なしで使える、完成済みのデザインテンプレート（Template）です。 */
export const siteTemplates = [
  {id:'maker-atelier',name:'Wentian Maker Atelier',description:'メーカー創業・製品・サイト市場の上質な多言語サンプル。中文・日本語・English・Français・Deutsch。',theme:'dark',accent:'#c9ad7c',headline:'让灵感，成为作品。',eyebrow:'WENTIAN · MAKER ATELIER',background:'#141715',cards:['Create','Curate','Circulate']},
  {id:'aurora',name:'Aurora AI',description:'深いネイビーと光のグラデーション。AI・SaaS向け。',theme:'dark',accent:'#9baaff',headline:'次の可能性を、\nあなたの手に。',eyebrow:'INTELLIGENCE, BEAUTIFULLY CONNECTED',background:'radial-gradient(ellipse at 85% 10%,#334878 0%,#0b1225 60%)',cards:['Intelligence','Connection','Possibility']},
  {id:'atelier',name:'Atelier Studio',description:'余白と大胆な文字で魅せる、クリエイティブスタジオ。',theme:'light',accent:'#b65736',headline:'静かな美しさ。\n強い存在感。',eyebrow:'DESIGN THAT MAKES A DIFFERENCE',background:'linear-gradient(135deg,#f5f0e8,#ffffff)',cards:['Identity','Experience','Craft']},
  {id:'maison',name:'Maison Luxe',description:'黒とゴールドの上質なブランド・ホテル向け。',theme:'dark',accent:'#d8b677',headline:'日常を超える、\n特別な体験。',eyebrow:'TIMELESS QUALITY · MODERN VISION',background:'radial-gradient(ellipse at top right,#443c2d,#151412 65%)',cards:['Heritage','Collection','Concierge']},
  {id:'horizon',name:'Horizon Business',description:'洗練されたブルー。企業・コンサルティング向け。',theme:'light',accent:'#2157bd',headline:'信頼を築き、\n未来をひらく。',eyebrow:'YOUR PARTNER FOR THE NEXT CHAPTER',background:'linear-gradient(120deg,#eef4ff,#ffffff)',cards:['Strategy','Technology','Partnership']},
] as const;

export function templateSite(id:unknown,base:PublicSite,title:string):PublicSite {
  if(id==='maker-atelier')return makerExampleSite(base,title);
  const template=siteTemplates.find(item=>item.id===id);if(!template)throw new Error('テンプレートを選択してください。');
  const hero=`<span class="eyebrow">${template.eyebrow}</span><h1>${template.headline.replaceAll('\n','<br>')}</h1><p>あなたのビジョンを、確かな価値へ。ここから始まる新しい体験を、私たちと一緒に。</p><div class="hero-actions"><a class="hero-primary" href="#contact">お問い合わせ ↗</a><a class="hero-secondary" href="#tile-section-0">私たちのサービス ↘</a></div>`;
  return {...structuredClone(base),revision:0,title,theme:template.theme,accent:template.accent,headline:template.headline,eyebrow:template.eyebrow,
    introduction:'あなたのビジョンを、確かな価値へ。ここから始まる新しい体験を、私たちと一緒に。',groupsPosition:'after',showRooms:false,
    sections:template.cards.map((name,index)=>({title:`0${index+1} / ${name}`,text:['本質を見極め、あなたに最適な方向を描きます。','細部までこだわり、心に残る体験をつくります。','長く寄り添い、次の成長をともに実現します。'][index],linkLabel:'詳しく見る',href:'#contact'})),
    customHtml:'<section id="contact"><p>LET’S START A CONVERSATION</p><h2>あなたの次の一歩を、ここから。</h2><p>会社名・サービス内容・連絡先を編集して、あなたのサイトとして公開してください。</p></section>',
    customCss:`body{background:${template.background};background-attachment:fixed}.tile-board{margin:36px auto}.site-tile{border-radius:24px;box-shadow:0 18px 48px #0000000c}.site-tile.public-hero{padding:48px;background:${template.background}}.site-tile.public-hero h1{font-size:clamp(32px,5vw,64px);letter-spacing:-2px;line-height:1.16}.content-card h3{letter-spacing:1px;font-size:23px}.content-card p{line-height:2}.tile-custom{padding:36px}.eyebrow{letter-spacing:3px}@media(max-width:650px){.site-tile.public-hero{padding:28px}.site-tile.public-hero h1{font-size:36px}}`,
    tiles:{header:{x:0,y:0,width:1200,height:90,html:`<strong>${title.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}</strong><nav><a href="#tile-section-0">サービス</a><a href="#contact">お問い合わせ ↗</a></nav>`,css:'font-size: 22px;'},hero:{x:0,y:110,width:1200,height:430,html:hero,css:'padding: 48px;'},
      'section-0':{x:0,y:565,width:388,height:240,html:'',css:''},'section-1':{x:406,y:565,width:388,height:240,html:'',css:''},'section-2':{x:812,y:565,width:388,height:240,html:'',css:''},
      custom:{x:0,y:830,width:1200,height:240,html:'',css:''},footer:{x:0,y:1095,width:1200,height:90,html:`<span>${title.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}</span><span>Crafted with Wentian</span>`,css:''}}};
}
