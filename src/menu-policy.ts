import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PublicControlCenterUser, ControlCenterRole } from './control-center-auth.js';
import { atomicOrdinaryWrite } from './safe-file.js';

export const menuItems = [
 ['home','ホーム'],['chat','AIと会話'],['/study','書斎'],['/direct-messages','個別チャット'],['/startup-forge','✦ 起業インキュベーター'],
 ['/meetings','ビデオ会議'],
 ['/wallet','ウォレット'],
 ['tasks','タスク・成果'],['/sites/mail-solutions/','メールを整理する'],['/operations','作業状況'],['/projects','プロジェクトと資料'],['groups','AIグループ'],['/workbench/groups','AIグループ一覧・管理'],
 ['site-list','作成済みサイト一覧'],['site','サイト編集'],['/visual-assets','背景と人物制作'],['/media-studio','音声・動画制作'],['/videos','動画生成'],
 ['models','モデル・接続先'],['agents','エージェント'],['users','ユーザー・アカウント'],['/menu-settings','メニュー表示設定'],['/execution-permissions','実行権限'],['/mcp-connections','MCP接続'],['/personal-cloud','Personal Cloud・実行PC'],
 ['/workflows','並列工程'],['skills','スキル（Skills）'],['/model-training','大規模言語モデル学習'],['lifecycle','モデル管理'],['marketplace','エージェントを追加'],['site-trash','閉鎖済みサイト・完全削除'],
 ['overview','稼働状況'],['improvements','対応状況'],['evaluation','モデル評価'],['verification','独立検証'],['evidence','検証証拠'],['routes','実行履歴'],
] as const;
const roles = ['admin','operator','viewer'] as const;
export type MenuPolicy = Record<ControlCenterRole, string[]>;
export function defaultMenuPolicy(): MenuPolicy {
  const common = ['home','/direct-messages','/meetings','users','/startup-forge','groups'];
  return { admin: menuItems.map(([id]) => id), operator: [...common,'chat','tasks','/operations','/projects'], viewer: [...common] };
}
export function validateMenuPolicy(value: unknown): MenuPolicy {
  const data = value as MenuPolicy;
  if (!data || Object.keys(data).length !== 3 || roles.some(role => !Array.isArray(data[role]) || new Set(data[role]).size !== data[role].length || data[role].some(id => !menuItems.some(([known]) => known === id)))) throw new Error('3権限の有効なメニュー項目を指定してください。');
  if (!data.admin.includes('/menu-settings') || !data.admin.includes('users')) throw new Error('管理者のメニュー表示設定とユーザー管理は非表示にできません。');
  return structuredClone(data);
}
export class MenuPolicyStore {
  private policy = defaultMenuPolicy(); private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  async load() { try {
    const value=JSON.parse(await readFile(this.file,'utf8'));
    // 旧アカウント入口の表示設定を統合先へ移行し、重複だけを取り除きます。
    for(const role of roles)if(Array.isArray(value?.[role]))value[role]=[...new Set(value[role].map((id:unknown)=>id==='/account'?'users':id))];
    this.policy=validateMenuPolicy(value);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  get() { return structuredClone(this.policy); }
  async save(value: unknown) {
    const policy = validateMenuPolicy(value);
    const operation = this.writes.catch(()=>undefined).then(async()=>{ await atomicOrdinaryWrite(this.file,JSON.stringify(policy)); this.policy=policy; });
    this.writes=operation; await operation; return this.get();
  }
}
export async function registerMenuPolicy(app: FastifyInstance, workspace: string, identity: (req:FastifyRequest)=>PublicControlCenterUser | undefined, admin:(req:FastifyRequest,reply:FastifyReply)=>unknown) {
  const store=new MenuPolicyStore(path.join(workspace,'.wentian','menu-policy.json'));await store.load();
  app.get('/api/navigation/menu',async(req,reply)=>{reply.header('cache-control','no-store');const user=identity(req);return {role:user?.role||'guest',visible:user?store.get()[user.role]:['home'],items:menuItems};});
  app.get('/api/navigation/policy',async(req,reply)=>{if(!admin(req,reply))return reply;reply.header('cache-control','no-store');return {policy:store.get(),items:menuItems};});
  app.put('/api/navigation/policy',async(req,reply)=>{
    if(!admin(req,reply))return reply;
    if((req.headers.origin&&req.headers.origin!==req.protocol+'://'+req.headers.host)||req.headers['sec-fetch-site']==='cross-site')return reply.code(403).send({error:{message:'同じサイトから操作してください。'}});
    try{return {policy:await store.save(req.body)};}catch(error){return reply.code(400).send({error:{message:error instanceof Error?error.message:'設定を保存できません。'}});}
  });
}
