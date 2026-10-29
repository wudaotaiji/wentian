/** 会議の録画操作は明示操作・全員承認を経て開始します。本文はtextContentで表示します。 */
export const meetingRecordingMarkup=`<section aria-label="会議の記録"><h2>録画・録音と議事録</h2>
<p>参加者全員の承認後に、受信できている映像・共有画面と会議音声を保存します。途中参加・退出・承認撤回では停止します。停止前に承認の下で保存された記録は、選択済みの設定で文字起こし・議事録の処理対象になります。</p>
<p>文字起こし・議事録は自動生成の下書きです。重要な発言は録画と照合してください。</p><label>保存内容<select id="recordingMode"><option value="video">映像と音声</option><option value="audio">音声のみ</option></select></label>
<label>文字起こし言語<select id="recordingLanguage"><option value="auto">自動判定</option><option value="ja">日本語</option><option value="zh">中国語</option><option value="en">英語</option></select></label>
<label>議事録モデル<select id="recordingModel"><option value="">モデルを選択</option></select></label>
<label><input type="checkbox" id="recordingAutomatic" checked>保存後に文字起こし・議事録を自動作成</label>
<button id="recordingRequest" disabled>録画・録音を申請</button><button id="recordingStop" disabled>録画停止・承認撤回</button>
<p id="recordingStatus" role="status"></p><div id="recordingConsent" class="meeting-consent" hidden><p id="recordingConsentText"></p><button id="recordingApprove">保存とAI処理を承認</button><button id="recordingDeny">承認しない</button></div>
<button id="recordingRefresh">保存した記録を更新</button><div id="meetingRecordings"></div></section>`;

export const meetingRecordingScript=`
let recordingConsent,meetingRecorder,recordingConfig={},recordingStarting=false,recordingsBusy=false;
const recordText=(tag,text)=>{const e=document.createElement(tag);e.textContent=text;return e;};
async function initMeetingRecordings(){
 recordingConfig=await api('/api/meetings/recordings/config');
 for(const model of recordingConfig.models||[]){const option=document.createElement('option');option.value=model.id;option.textContent=model.id;$('recordingModel').append(option);}
 try{const saved=localStorage.getItem('wentian.meetings.minutesModel');if((recordingConfig.models||[]).some(m=>m.id===saved))$('recordingModel').value=saved;}catch{}
 await refreshMeetingRecordings();
}
function recordingNotice(text){$('recordingStatus').textContent=t(text);}
function recordingAvailability(){if(!self)return;$('recordingRequest').disabled=!!recordingConsent||recordingStarting||!!meetingRecorder||typeof MediaRecorder==='undefined';}
function handleRecordingMessage(message){
 if(message.type==='recording-request'){
  recordingConsent=message;$('recordingRequest').disabled=true;$('recordingStop').disabled=false;
  $('recordingConsentText').textContent=message.name+' · '+t(message.mode==='audio'?'音声のみ':'映像と音声')+' / '+t('保存・文字起こし・AI議事録の作成に使用します。')+' '+(message.model||t('議事録モデル未選択'));
  $('recordingConsent').hidden=message.owner===self;recordingNotice('参加者全員の承認を待っています。');return true;
 }
 if(message.type==='recording-ready'){
  recordingConsent=message;$('recordingConsent').hidden=true;$('recordingStop').disabled=false;recordingNotice('録画・録音中です。承認はいつでも撤回できます。');
  if(message.owner===self)void startMeetingRecording(message).catch(error=>{recordingNotice(error.message);try{send({type:'stop-recording',id:message.id});}catch{}});return true;
 }
 if(message.type==='recording-ended'){
  recordingConsent=undefined;$('recordingConsent').hidden=true;$('recordingStop').disabled=true;void stopMeetingRecording();recordingAvailability();if(!meetingRecorder)recordingNotice('録画・録音を停止しました。');return true;
 }return false;
}
$('recordingRequest').onclick=()=>{try{if(!self)throw Error(t('会議に参加してください。'));if(typeof MediaRecorder==='undefined')throw Error(t('このブラウザーは録画に対応していません。'));const model=$('recordingModel').value;if($('recordingAutomatic').checked&&!model)throw Error(t('議事録モデルを選択してください。'));try{localStorage.setItem('wentian.meetings.minutesModel',model);}catch{}send({type:'request-recording',mode:$('recordingMode').value,model,automatic:$('recordingAutomatic').checked,language:$('recordingLanguage').value});}catch(error){recordingNotice(error.message);}};
$('recordingApprove').onclick=()=>{if(recordingConsent){send({type:'approve-recording',id:recordingConsent.id});$('recordingConsent').hidden=true;}};
function revokeRecording(){if(recordingConsent)try{send({type:'stop-recording',id:recordingConsent.id});}catch{}void stopMeetingRecording();}
$('recordingDeny').onclick=revokeRecording;$('recordingStop').onclick=revokeRecording;
async function startMeetingRecording(consent){
 if(recordingStarting||meetingRecorder)return;recordingStarting=true;
 let audio,stream,canvas,timer,recorder,row;const nodes=new Map();
 try{
  const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)throw Error(t('音声の混合に対応したブラウザーで開いてください。'));
  audio=new Audio();await audio.resume();if(recordingConsent?.id!==consent.id)throw Error(t('録画の承認が取り消されました。'));
  const destination=audio.createMediaStreamDestination();stream=new MediaStream();for(const track of destination.stream.getAudioTracks())stream.addTrack(track);
  const refreshAudio=()=>{const sources=[local,...[...peers.values()].flatMap(p=>[...p.streams.values()])],live=new Set();for(const source of sources)for(const track of source.getAudioTracks()){if(track.readyState==='ended')continue;live.add(track.id);if(!nodes.has(track.id)){const one=new MediaStream();one.addTrack(track);const node=audio.createMediaStreamSource(one);node.connect(destination);nodes.set(track.id,node);}}for(const [id,node]of nodes)if(!live.has(id)){node.disconnect();nodes.delete(id);}};
  refreshAudio();
  if(consent.mode==='video'){
   canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const ctx=canvas.getContext('2d');if(!ctx||!canvas.captureStream)throw Error(t('映像の録画に対応していません。'));
   const draw=()=>{ctx.fillStyle='#07101e';ctx.fillRect(0,0,1280,720);const videos=[...document.querySelectorAll('#meetingVideos video')].filter(v=>v.videoWidth&&v.videoHeight);const columns=Math.ceil(Math.sqrt(Math.max(1,videos.length))),rows=Math.ceil(Math.max(1,videos.length)/columns),w=1280/columns,h=720/rows;videos.forEach((v,i)=>{const scale=Math.min(w/v.videoWidth,(h-28)/v.videoHeight),x=(i%columns)*w,y=Math.floor(i/columns)*h;ctx.drawImage(v,x+(w-v.videoWidth*scale)/2,y,v.videoWidth*scale,v.videoHeight*scale);ctx.fillStyle='#fff';ctx.font='16px sans-serif';ctx.fillText(v.parentElement.querySelector('h3')?.textContent||'',x+8,y+h-8,w-16);});};
   draw();const captured=canvas.captureStream(10);for(const track of captured.getVideoTracks())stream.addTrack(track);timer=setInterval(()=>{refreshAudio();draw();},200);
  }else timer=setInterval(refreshAudio,500);
  const choices=consent.mode==='video'?['video/webm;codecs=vp8,opus','video/webm','video/mp4']:['audio/webm;codecs=opus','audio/webm','audio/mp4'];const mime=choices.find(type=>MediaRecorder.isTypeSupported(type));if(!mime)throw Error(t('保存できる録画形式がありません。'));
  row=await api('/api/meetings/recordings','POST',{group:$('meetingGroup').value,peer:self,session:consent.id,mime:mime.split(';')[0]});
  if(recordingConsent?.id!==consent.id)throw Error(t('録画の承認が取り消されました。'));
  recorder=new MediaRecorder(stream,{mimeType:mime,...(consent.mode==='video'?{videoBitsPerSecond:1000000}:{audioBitsPerSecond:96000})});
  const state={recorder,row,audio,stream,timer,nodes,sequence:0,pending:0,bytes:0,failed:false,uploads:Promise.resolve(),stopped:false,stopPromise:null,limitTimer:null};meetingRecorder=state;
  recorder.ondataavailable=event=>{if(!event.data?.size||state.failed)return;state.pending+=event.data.size;state.bytes+=event.data.size;if(state.pending>24*1024*1024||state.bytes>(recordingConfig.maxBytes||1024**3)){state.failed=true;recordingNotice('保存が追いつかないか、録画の容量上限に達したため停止します。');revokeRecording();return;}const sequence=state.sequence++;state.uploads=state.uploads.then(async()=>{let failure;for(let retry=0;retry<3;retry++){try{const response=await fetch('/api/meetings/recordings/'+row.id+'/chunks/'+sequence,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:event.data});if(!response.ok)throw Error((await response.json()).error?.message||t('録画を保存できません。'));state.pending-=event.data.size;return;}catch(error){failure=error;if(retry<2)await new Promise(resolve=>setTimeout(resolve,500));}}throw failure;}).catch(error=>{state.failed=true;recordingNotice(error.message);if(!state.stopped)revokeRecording();throw error;});state.uploads.catch(()=>{});};
  recorder.onerror=()=>{state.failed=true;recordingNotice('録画に失敗しました。保存済みの部分は記録一覧で確認できます。');revokeRecording();};
  recorder.onstop=()=>{state.stopped=true;clearInterval(timer);clearTimeout(state.limitTimer);for(const node of nodes.values())node.disconnect();for(const track of stream.getTracks())track.stop();void audio.close();
   state.stopPromise=(async()=>{try{await state.uploads.catch(()=>{state.failed=true;});await api('/api/meetings/recordings/'+row.id+'/finish','POST',{partial:state.failed});recordingNotice(state.failed?'保存済みの部分を残しました。録画は途中までです。':'録画を保存しました。自動処理の状態は記録一覧で確認できます。');}catch(error){recordingNotice(error.message+' '+t('未保存の最後の部分がある可能性があります。'));}finally{if(meetingRecorder===state)meetingRecorder=undefined;recordingAvailability();void refreshMeetingRecordings();}})();};
  state.limitTimer=setTimeout(revokeRecording,(recordingConfig.maxSeconds||14400)*1000);recorder.start(5000);recordingNotice('録画・録音中です。承認はいつでも撤回できます。');
 }catch(error){clearInterval(timer);for(const node of nodes.values())node.disconnect();for(const track of stream?.getTracks()||[])track.stop();void audio?.close();throw error;}finally{recordingStarting=false;recordingAvailability();}
}
async function stopMeetingRecording(){const state=meetingRecorder;if(state&&!state.stopped&&state.recorder.state!=='inactive'){state.recorder.stop();}if(state?.stopPromise)await state.stopPromise;}
function recordingLeft(){if(recordingConsent)try{send({type:'stop-recording',id:recordingConsent.id});}catch{}recordingConsent=undefined;$('recordingConsent').hidden=true;$('recordingRequest').disabled=true;$('recordingStop').disabled=true;void stopMeetingRecording();}
async function refreshMeetingRecordings(){if(recordingsBusy||!$('meetingGroup').value)return;recordingsBusy=true;try{const result=await api('/api/meetings/recordings?group='+encodeURIComponent($('meetingGroup').value));$('meetingRecordings').replaceChildren();for(const row of result.recordings||[]){const card=document.createElement('article');card.className='meeting-card';card.append(recordText('h3',new Date(row.createdAt).toLocaleString()+' · '+t(row.mode==='audio'?'音声のみ':'映像と音声')));const labels={recording:'保存中',saved:'保存済み',queued:'処理待ち',transcribing:'文字起こし中',minutes:'議事録作成中',ready:'文字起こし・議事録作成済み',transcribed:'文字起こし済み・議事録モデル未選択',failed:'処理未完了・再処理できます'};card.append(recordText('p',t(labels[row.status]||row.status)));if(row.partial)card.append(recordText('p','途中までの録画です。議事録も保存できた範囲のみを扱います。'));if(row.error)card.append(recordText('p',row.error));if(row.bytes){const link=recordText('a','録画・音声をダウンロード');link.href='/api/meetings/recordings/'+row.id+'/media';link.download='';card.append(link);}const detail=recordText('button','文字起こし・議事録を表示');detail.onclick=async()=>{try{const data=await api('/api/meetings/recordings/'+row.id);const area=document.createElement('div');area.dataset.noTranslate='';if(data.segments){const transcript=recordText('pre',data.segments.map(s=>'['+s.start.toFixed(1)+'–'+s.end.toFixed(1)+'] '+s.text).join('\\n'));transcript.style.whiteSpace='pre-wrap';area.append(transcript);const link=recordText('a','文字起こしをダウンロード');link.href='/api/meetings/recordings/'+row.id+'/transcript';link.download='';area.append(link);}if(data.minutes){area.append(recordText('h4','AI議事録の下書き（内容を確認してください）'));for(const [key,label]of [['summary','要約'],['decisions','決定事項'],['actions','対応事項'],['openQuestions','未解決事項']]){area.append(recordText('h4',label));for(const item of data.minutes[key]){area.append(recordText('p',item.text+(key==='actions'?' / '+(item.assignee||'担当未確認')+' / '+(item.due||'期限未確認'):'')));for(const e of item.evidence)area.append(recordText('blockquote','['+data.segments[e.segment].start.toFixed(1)+'秒] '+e.quote));}}const download=recordText('button','議事録をダウンロード');download.onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(data.minutes,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='minutes-'+row.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};area.append(download);}if(!data.minutes&&!data.segments)area.append(recordText('p','文字起こし・議事録は未作成です。'));detail.after(area);detail.disabled=true;}catch(error){recordingNotice(error.message);}};card.append(detail);if(!row.complete&&row.bytes&&row.canManage&&meetingRecorder?.row.id!==row.id){const recover=recordText('button','中断した録画の保存済み部分を確定');recover.onclick=async()=>{recover.disabled=true;try{await api('/api/meetings/recordings/'+row.id+'/finish','POST',{partial:true});await refreshMeetingRecordings();}catch(error){recordingNotice(error.message);recover.disabled=false;}};card.append(recover);}if(row.canManage&&row.complete&&['saved','failed','ready','transcribed'].includes(row.status)){const retry=recordText('button',row.model?'文字起こし・議事録を作成／再処理':'文字起こしを作成／再処理');retry.onclick=async()=>{retry.disabled=true;try{await api('/api/meetings/recordings/'+row.id+'/process','POST',{});await refreshMeetingRecordings();}catch(error){recordingNotice(error.message);retry.disabled=false;}};card.append(retry);}$('meetingRecordings').append(card);}}catch(error){recordingNotice(error.message);}finally{recordingsBusy=false;}}
window.addEventListener('beforeunload',event=>{if(meetingRecorder||recordingStarting){event.preventDefault();event.returnValue='';}});
$('recordingRefresh').onclick=()=>refreshMeetingRecordings();$('meetingGroup').addEventListener('change',()=>refreshMeetingRecordings());setInterval(()=>{if(!document.hidden)void refreshMeetingRecordings();},10000);
`;
