import { createPublicKey, verify } from 'node:crypto';

/** Cloudflare Accessの署名済みJWT（JSON Web Token）を、公開鍵・対象アプリ・発行者・期限で確認します。 */
export class AccessVerifier {
  private keys:Record<string,unknown>[]=[];
  private expires=0;
  constructor(readonly team:string,readonly audience:string){if(!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)||!audience)throw new Error('Cloudflare Accessのチームと対象識別子が不正です。');}
  async authorize(token:string|undefined):Promise<boolean>{
    if(!token||token.length>16000)return false;
    try{
      const parts=token.split('.');if(parts.length!==3)return false;
      const header=JSON.parse(Buffer.from(parts[0],'base64url').toString()),body=JSON.parse(Buffer.from(parts[1],'base64url').toString());
      if(header.alg!=='RS256'||typeof header.kid!=='string'||body.iss!=='https://'+this.team||!Number.isFinite(body.exp)||body.exp<=Date.now()/1000||(body.nbf&&body.nbf>Date.now()/1000)||!(Array.isArray(body.aud)?body.aud:[body.aud]).includes(this.audience))return false;
      if(Date.now()>this.expires){const response=await fetch('https://'+this.team+'/cdn-cgi/access/certs',{redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok)return false;const data=await response.json() as {keys:Record<string,unknown>[]};if(!Array.isArray(data.keys))return false;this.keys=data.keys;this.expires=Date.now()+300000;}
      const key=this.keys.find(k=>k.kid===header.kid&&k.kty==='RSA');if(!key)return false;
      return verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key:key as import('node:crypto').webcrypto.JsonWebKey,format:'jwk'}),Buffer.from(parts[2],'base64url'));
    }catch{return false;}
  }
}
