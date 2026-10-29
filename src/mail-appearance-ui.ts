/** メール画面に5種類のスタイル（Style）を適用し、選択をブラウザごとに保持します。 */
export function withMailAppearance(html: string, theme = 'light'): string {
  const initial = ['light', 'dark', 'glass', 'bento', 'minimal'].includes(theme) ? theme : 'light';
  // 保存済みHTMLを上書きせず、表示時に色・余白・形状を追加します。
  const style = `<style id="mailAppearanceCss">
/* 保存済みの画面にも適用し、低いウィンドウでもメニュー末尾へ移動できるようにします。 */
.side{overflow-y:scroll;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:auto;scrollbar-color:#92a0ae #17283b;scrollbar-gutter:stable;height:100vh;height:100dvh;min-height:0}
.side>*{flex-shrink:0}
.side::-webkit-scrollbar{width:12px}
.side::-webkit-scrollbar-track{background:#17283b}
.side::-webkit-scrollbar-thumb{background:#92a0ae;border:3px solid #17283b;border-radius:8px}
html[data-mail-style=dark]{color-scheme:dark;--paper:#111c29;--white:#1b2938;--ink:#e7eef5;--muted:#a6b6c7;--line:#36485c;--navy:#334e6b;--teal:#74d6c5;--teal-soft:#25483f;--gold-soft:#443a26}
html[data-mail-style=glass]{--paper:#edf3fb;--white:#ffffffc9;--ink:#253b56;--line:#c8d9e8;--teal:#386fac;--teal-soft:#e3edf9;--radius:22px}
html[data-mail-style=glass] body{background:linear-gradient(135deg,#e1f3f0,#e9e6fa)}
html[data-mail-style=glass] .panel,html[data-mail-style=glass] .metric{backdrop-filter:blur(15px);box-shadow:0 10px 35px #4b68951a}
html[data-mail-style=bento]{--paper:#eff3ed;--white:#fff;--ink:#27352b;--teal:#346c4d;--teal-soft:#e5efe3;--radius:24px}
html[data-mail-style=bento] .panel,html[data-mail-style=bento] .metric{border:0;box-shadow:0 6px 20px #283e2910;padding:24px}
html[data-mail-style=minimal]{--paper:#fff;--white:#fff;--ink:#20252b;--muted:#64707c;--line:#dce1e5;--teal:#354658;--teal-soft:#edf0f3;--radius:3px}
html[data-mail-style=minimal] .panel,html[data-mail-style=minimal] .metric{box-shadow:none}
html[data-mail-style=minimal] .side{background:#202a36}
html[data-mail-style=dark] .topbar{background:#1b2938ed}
html[data-mail-style=dark] :is(input,select,textarea,.secondary,.icon-btn,.mobile-menu,.review-card,.filter,.field){background:var(--white)!important;color:var(--ink)!important;border-color:var(--line)!important}
html[data-mail-style=dark] :is(.queue-item,td,.mail-live-card){border-color:var(--line)}
html[data-mail-style=dark] :is(.mail-subject,.field input,.crumb strong,.panel-title){color:var(--ink)}
.mail-style-label{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:11px}.mail-style-label select{max-width:180px}
@media(max-width:700px){.topbar{height:auto;min-height:61px;padding-top:8px;padding-bottom:8px;gap:8px;flex-wrap:wrap}.top-actions{flex-wrap:wrap}.mail-style-label{font-size:10px}.mail-style-label select{max-width:125px}}
</style>`;
  const script = `<script id="mailAppearanceScript">
(()=>{'use strict';
const choices=[['light','ライト（Light）'],['dark','ダーク（Dark）'],['glass','グラス（Glass）'],['bento','ベントー（Bento）'],['minimal','ミニマル（Minimal）']],key='wentian-mail-style';
let value=${JSON.stringify(initial)};try{const saved=localStorage.getItem(key);if(choices.some(c=>c[0]===saved))value=saved}catch{}
const apply=style=>{document.documentElement.dataset.mailStyle=style};apply(value);
const host=document.querySelector('.top-actions');if(!host)return;
const label=document.createElement('label');label.className='mail-style-label';label.textContent='サイトスタイル';const select=document.createElement('select');select.id='mailSiteStyle';select.className='select';select.setAttribute('aria-label','サイトスタイル');
for(const [id,name]of choices){const option=document.createElement('option');option.value=id;option.textContent=name;select.append(option)}select.value=value;
select.onchange=()=>{apply(select.value);try{localStorage.setItem(key,select.value)}catch{}};label.append(select);host.prepend(label);
})();</script>`;
  // プレビュー（Preview）ではスクリプトが無効でも保存したスタイルが表示されます。
  return html.replace(/<html\b/, `<html data-mail-style="${initial}"`).replace('</head>', style + '</head>').replace('</body>', script + '</body>');
}
