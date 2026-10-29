import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { CloudError } from './types.js';
import { AppProxy } from './proxy.js';
import { AccessVerifier } from './access.js';

/** トンネル（Tunnel）はアプリ専用プロキシだけを公開し、未検証のURLを公開完了にしません。 */
export class TunnelConnector {
  private processes=new Map<string,ChildProcess>();
  constructor(private root:string,private executable=process.env.WENTIAN_CLOUDFLARED||'cloudflared'){}
  async publish(appId:string,proxy:AppProxy,input:{mode:'quick'|'named';anonymous:boolean;hostname?:string;allowedEmails?:string[]}){
    if(this.processes.has(appId))throw new CloudError('既にトンネル接続中です。解除してから変更してください。',409);
    if(proxy.port===8787||!proxy.targetPort)throw new CloudError('起動済みアプリ専用ポートだけを公開できます。');
    const args=['tunnel','--no-autoupdate'];let publicUrl='';
    if(input.mode==='quick'){
      args.push('--url','http://127.0.0.1:'+proxy.port);
      if(!input.anonymous){if(!input.allowedEmails?.length)throw new CloudError('検証用公開の許可メールアドレスを指定してください。');for(const email of input.allowedEmails)args.push('--allowed-mail',email);}
    }
    else {
      // ノードごとの資格情報ファイル（Credential File）はローカル設定だけから読みます。
      // Cloudflare運営アカウントのAPIトークンをAgentへ配布しません。
      const credential=process.env.WENTIAN_TUNNEL_CREDENTIALS_FILE;
      if(!credential||!input.hostname)throw new CloudError('通常Tunnelのノード資格情報とホスト名が未設定です。',409);
      if(!input.anonymous){const team=process.env.WENTIAN_ACCESS_TEAM,audience=process.env.WENTIAN_ACCESS_AUD;if(!team||!audience)throw new CloudError('認証付き公開にはCloudflare Accessのチームと対象識別子が必要です。',409);proxy.access=new AccessVerifier(team,audience);}else proxy.access=undefined;
      if((await lstat(credential)).isSymbolicLink())throw new CloudError('資格情報にリンクは指定できません。');
      const data=JSON.parse(await readFile(credential,'utf8'));
      if(typeof data.TunnelID!=='string'||! /^[a-f0-9-]{36}$/.test(data.TunnelID))throw new CloudError('Tunnel IDが不正です。');
      // 1資格情報を複数アプリで使うとルートが競合するため、通常方式は現段階で1アプリに限定します。
      if(this.processes.size)throw new CloudError('通常Tunnelは現在1ノード1アプリです。',409);
      await mkdir(this.root,{recursive:true});const config=path.join(this.root,appId+'.json');
      await writeFile(config,JSON.stringify({tunnel:data.TunnelID,'credentials-file':path.resolve(credential),ingress:[{hostname:input.hostname,service:'http://127.0.0.1:'+proxy.port},{service:'http_status:404'}]}),{mode:0o600});
      args.push('--config',config,'run',data.TunnelID);publicUrl='https://'+input.hostname;proxy.allowedHost=input.hostname;
    }
    const child=spawn(this.executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});this.processes.set(appId,child);
    return await new Promise<{publicUrl:string;publication:string}>((resolve,reject)=>{
      let settled=false,buffer='';const timeout=setTimeout(()=>fail('トンネルの接続確認が期限切れです。'),30000);
      const fail=(reason:string)=>{if(settled)return;settled=true;clearTimeout(timeout);child.kill();this.processes.delete(appId);proxy.allowedHost='';reject(new CloudError(reason,409));};
      const receive=(chunk:Buffer)=>{
        buffer=(buffer+chunk.toString()).slice(-16000);
        const quick=buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if(input.mode==='quick'&&quick){publicUrl=quick[0];proxy.allowedHost=new URL(publicUrl).hostname;}
        if(!settled&&publicUrl&&/Registered tunnel connection|registered.*connection/i.test(buffer)){
          settled=true;clearTimeout(timeout);resolve({publicUrl,publication:input.mode==='quick'?'temporary_unverified':'dns_tls_unverified'});
        }
      };
      child.stdout?.on('data',receive);child.stderr?.on('data',receive);
      child.once('error',()=>fail('cloudflaredが未導入または起動できません。'));
      child.once('exit',()=>{this.processes.delete(appId);proxy.allowedHost='';fail('トンネル接続が終了しました。');});
    });
  }
  /** 公開解除（Unpublish）は先にHost経路を遮断し、プロセス停止と区別します。 */
  unpublish(appId:string,proxy:AppProxy){proxy.allowedHost='';proxy.access=undefined;const child=this.processes.get(appId);child?.kill();this.processes.delete(appId);}
}
