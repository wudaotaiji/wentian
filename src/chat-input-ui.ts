/** 会話欄の高さ調整と、送信前に確認できる音声入力を追加します。音声や下書きは保存しません。 */
export function withChatInput(html: string): string {
  const height=`<div class="chat-input-controls"><label for="chatHeight">会話欄の高さ</label><input id="chatHeight" type="range" min="180" max="1000" step="20" value="360"><output id="chatHeightValue" for="chatHeight">360 px</output><button id="chatHeightReset" type="button">高さをリセット</button></div>`;
  const voice=`<div class="chat-input-controls"><button id="chatVoice" type="button" aria-pressed="false">音声入力</button><span id="chatVoiceStatus" role="status" aria-live="polite"></span><span id="chatVoicePreview" data-no-translate></span></div><p class="muted chat-voice-note">認識した文を入力欄へ追加します。内容を確認してから送信してください。ブラウザーの設定によって音声が認識サービスへ送信されます。</p>`;
  const style=`<style>#chatLog{height:360px;min-height:180px;max-height:1000px;resize:vertical;overflow:auto}.chat-input-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0}.chat-input-controls label{margin:0}.chat-input-controls input[type=range]{width:220px;max-width:100%;padding:0}.chat-voice-note{font-size:12px}#chatVoicePreview{white-space:pre-wrap;color:var(--muted)}</style>`;
  const script=`<script>(()=>{'use strict';
const el=id=>document.getElementById(id),t=value=>window.wentianUi?.t(value)||value,log=el('chatLog'),input=el('chatInput'),voice=el('chatVoice'),status=el('chatVoiceStatus'),preview=el('chatVoicePreview');
if(!log||!input||!voice)return;
const height=el('chatHeight'),heightValue=el('chatHeightValue');
function setHeight(value){const pixels=Math.max(180,Math.min(1000,Number(value)||360));log.style.height=pixels+'px';height.value=String(pixels);heightValue.textContent=pixels+' px'}
height.oninput=()=>setHeight(height.value);el('chatHeightReset').onclick=()=>setHeight(360);
if(typeof ResizeObserver==='function')new ResizeObserver(()=>{const pixels=Math.round(log.getBoundingClientRect().height);if(pixels>=180&&pixels<=1000){height.value=String(pixels);heightValue.textContent=pixels+' px'}}).observe(log);
const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
let recognition,stopping=false,message='音声入力を開始できます。';
function availableMessage(){if(!window.isSecureContext)return 'このHTTP接続ではマイクを利用できません。サーバーと同じPCではlocalhost、別のPCではHTTPSで開くか、OSの音声入力（Windows: Win+H）を利用してください。';if(!Recognition)return 'このブラウザーは音声認識に対応していません。OSの音声入力を利用してください。';return '音声入力を開始できます。'}
function render(){voice.textContent=t(recognition?'音声入力を停止':'音声入力');voice.setAttribute('aria-pressed',String(!!recognition));voice.disabled=stopping||el('chatSend').disabled;status.textContent=t(message)}
function abort(){const current=recognition;recognition=undefined;stopping=false;preview.textContent='';if(current)try{current.abort()}catch{}message=availableMessage();render()}
function insert(text){const start=input.selectionStart??input.value.length,end=input.selectionEnd??start;const before=input.value.slice(0,start),prefix=before&&!before.endsWith(' ')&&!before.endsWith(String.fromCharCode(10))?' ':'';const value=prefix+text;if(typeof input.setRangeText==='function')input.setRangeText(value,start,end,'end');else input.value=before+value+input.value.slice(end);input.dispatchEvent(new Event('input',{bubbles:true}));input.focus()}
voice.onclick=()=>{
 if(recognition){stopping=true;message='音声入力を停止しています…';render();try{recognition.stop()}catch{abort()}return}
 if(!window.isSecureContext||!Recognition){message=availableMessage();input.focus();render();return}
 try{
  const current=new Recognition(),finals=new Set();recognition=current;stopping=false;
  current.lang=({ja:'ja-JP',en:'en-US',zh:'zh-CN'})[window.wentianUi?.language()||'ja'];current.continuous=true;current.interimResults=true;
  current.onresult=event=>{if(recognition!==current)return;const interim=[];for(let i=event.resultIndex||0;i<event.results.length;i++){const result=event.results[i],text=result[0]?.transcript||'';if(result.isFinal){if(!finals.has(i)){finals.add(i);if(text.trim())insert(text.trim())}}else interim.push(text)}preview.textContent=interim.join(' ')};
  current.onerror=event=>{if(recognition!==current)return;message=event.error==='not-allowed'||event.error==='service-not-allowed'?'マイクの利用が許可されていません。ブラウザーのサイト権限を確認してください。':event.error==='no-speech'?'音声を認識できませんでした。もう一度お話しください。':'音声入力に失敗しました。ブラウザーの権限と接続を確認してください。';recognition=undefined;stopping=false;preview.textContent='';try{current.abort()}catch{}render()};
  current.onend=()=>{if(recognition!==current)return;recognition=undefined;stopping=false;preview.textContent='';message='音声入力を停止しました。入力内容を確認して送信してください。';render()};
  message='音声を認識しています…';render();current.start();
 }catch{abort();message='音声入力を開始できませんでした。マイクの権限を確認してください。';render()}
};
el('chatForm').addEventListener('submit',abort,true);el('chatNew').addEventListener('click',abort,true);window.addEventListener('pagehide',abort);window.addEventListener('hashchange',()=>{if(location.hash!=='#chat')abort()});
document.addEventListener('wentian-language-changed',()=>{abort();render()});
new MutationObserver(()=>{if(el('chatSend').disabled&&recognition)abort();render()}).observe(el('chatSend'),{attributes:true,attributeFilter:['disabled']});
message=availableMessage();render();
})();</script>`;
  return html.replace('</head>',style+'</head>').replace('<div id="chatLog"',height+'<div id="chatLog"').replace('<form id="chatForm"',voice+'<form id="chatForm"').replace('</body>',script+'</body>');
}
