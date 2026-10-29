import { mailEndpoint, mailSecret } from './mail-connectors.js';
import type { MailEntity } from './mail-repository.js';

/** 指定されたBusinessRecordsの既存スキーマ（Schema）へ、確認済み項目だけを変換します。 */
export function businessRecord(job:MailEntity):Record<string,any>{
  const fields=job.fields,personnel=job.profileKind==='personnel';
  const required=personnel?['name','type','status','role','availability','owner','skills','rate','experience']:['title','client','role','start_date','deadline','status','owner','skills','rate'];
  const missing=required.filter(key=>typeof fields[key]!=='string'||!fields[key].trim());
  if(missing.length)throw Object.assign(new Error('BusinessRecordsの必須項目が不足しています: '+missing.join(', ')),{definiteFailure:true});
  for(const value of Object.values(fields))if(typeof value!=='string'||/[<>]/.test(value))throw Object.assign(new Error('登録項目にHTMLの山括弧は使用できません。'),{definiteFailure:true});
  const number=(key:string,defaultValue?:number)=>{if(!fields[key]&&defaultValue!==undefined)return defaultValue;const raw=fields[key].replace(/[,，\s]/g,'');if(!/^\d+(?:\.\d+)?$/.test(raw)||!Number.isFinite(Number(raw)))throw Object.assign(new Error(key+'は単位・通貨記号を含まない非負の数値で確認してください。'),{definiteFailure:true});return Number(raw);};
  const date=(key:string)=>{const value=fields[key];if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw Object.assign(new Error(key+'は実在するYYYY-MM-DD形式の日付で確認してください。'),{definiteFailure:true});return value;};
  const common={id:'WM-'+job.id.replaceAll('-','').toUpperCase(),skills:fields.skills.split(/[,，、]/).map((s:string)=>s.trim()).filter(Boolean),role:fields.role,status:fields.status,owner:fields.owner,location:fields.location||'',wentianMailId:job.mailId,wentianJobId:job.id};
  if(personnel)return {...common,name:fields.name,type:fields.type,available:date('availability'),desiredRate:number('rate'),experience:number('experience'),cost:number('cost',0),remote:fields.remote||'',proposals:0,interviews:0};
  return {...common,title:fields.title,client:fields.client,rate:number('rate'),start:date('start_date'),deadline:date('deadline'),summary:fields.description||'',priority:fields.priority||''};
}

/** Cookie認証（Cookie Authentication）を使い、セッションはサーバー内だけで保持します。 */
async function session(config:any){
  const base=mailEndpoint(config.baseUrl).replace(/\/$/,'');
  const response=await fetch(base+'/api/login',{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({username:config.username,password:mailSecret(config.passwordEnv)}),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Object.assign(new Error('BusinessRecordsにログインできません。HTTP '+response.status),{definiteFailure:true});
  const cookie=response.headers.get('set-cookie')?.match(/(?:^|[,;]\s*)(ses_session=[^;,\s]+)/)?.[1];
  if(!cookie)throw Object.assign(new Error('BusinessRecordsの認証Cookieが取得できません。'),{definiteFailure:true});
  return {base,cookie};
}
async function logout(auth:{base:string;cookie:string}){await fetch(auth.base+'/api/logout',{method:'POST',headers:{cookie:auth.cookie,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)}).catch(()=>{});}
async function readState(auth:{base:string;cookie:string}){
  const response=await fetch(auth.base+'/api/state',{headers:{cookie:auth.cookie},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Object.assign(new Error('BusinessRecordsの共有データを取得できません。HTTP '+response.status),{definiteFailure:true});
  const raw=await response.text();if(raw.length>5*1024*1024)throw Object.assign(new Error('BusinessRecordsの共有データが上限を超えています。'),{definiteFailure:true});
  const state=JSON.parse(raw);if(!Number.isSafeInteger(state.version)||!Array.isArray(state.data?.engineers)||!Array.isArray(state.data?.projects))throw Object.assign(new Error('BusinessRecordsの応答形式が一致しません。'),{definiteFailure:true});return state;
}
export async function testBusinessRecords(config:any){const auth=await session(config);try{const state=await readState(auth);return {connected:true,role:state.user?.role,version:state.version,engineers:state.data.engineers.length,projects:state.data.projects.length};}finally{await logout(auth);}}

/** 世代番号を使って1件だけ追加します。既存レコードは変更せず、同一ジョブIDの再送も二重登録しません。 */
export async function sendBusinessRecords(config:any,job:MailEntity):Promise<{remoteId:string}>{
  const record=businessRecord(job),auth=await session(config);
  try {
    for(let attempt=0;attempt<3;attempt++){
      const state=await readState(auth),key=job.profileKind==='personnel'?'engineers':'projects';
      const existing=state.data[key].find((item:any)=>item.id===record.id||item.wentianJobId===job.id);
      if(existing){if(existing.wentianJobId!==job.id)throw Object.assign(new Error('登録IDが既存データと衝突しています。'),{definiteFailure:true});return {remoteId:existing.id};}
      state.data[key].unshift(record);
      const payload=JSON.stringify({version:state.version,data:state.data,action:'Wentian Mail Solutions: '+job.id});
      if(Buffer.byteLength(payload)>5*1024*1024)throw Object.assign(new Error('BusinessRecordsの更新サイズ上限を超えています。'),{definiteFailure:true});
      const response=await fetch(auth.base+'/api/state',{method:'PUT',redirect:'error',headers:{cookie:auth.cookie,'content-type':'application/json'},body:payload,signal:AbortSignal.timeout(20000)});
      if(response.status===409)continue;
      if(!response.ok)throw Object.assign(new Error('BusinessRecordsへの登録に失敗しました。HTTP '+response.status),{definiteFailure:response.status>=400&&response.status<500&&response.status!==408});
      // 更新応答だけで成功とせず、読み直した共有データに同一ジョブがあることを確認します。
      const confirmed=await readState(auth).catch(error=>{throw Object.assign(new Error('登録要求後の照合に失敗しました。登録先を確認してください。'),{cause:error});});
      if(!confirmed.data[key].some((item:any)=>item.id===record.id&&item.wentianJobId===job.id))throw new Error('登録後のレコードを確認できません。登録先を照合してください。');
      return {remoteId:record.id};
    }
    throw Object.assign(new Error('BusinessRecordsが他の利用者によって更新されています。時間をおいて再試行してください。'),{definiteFailure:true});
  }finally{await logout(auth);}
}
