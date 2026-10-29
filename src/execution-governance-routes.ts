import { maintenanceWorkspaces } from './maintenance-workspaces.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { executionSummary, grantExecution, revokeExecution, grantProjectExecution, revokeProjectExecution, configureDefaultExecution } from './execution-governance.js';
import { executionCenterHtml } from './execution-governance-ui.js';
import { providerDataSummary, setProviderDataBlocked } from './provider-data-policy.js';

/** 主体は管理者認証から取得します。本文の操作者指定や外部Originは採用しません。 */
export function registerExecutionGovernance(app: FastifyInstance, options: { authorize:(req:FastifyRequest,reply:FastifyReply)=>boolean|Promise<boolean>; identity:(req:FastifyRequest)=>string|undefined; workspace:string; providers?:()=>Array<{id:string;baseUrl:string;scope:string;enabled?:boolean}>; onAccessChange?:(agent?:string)=>void }):void {
  app.get('/execution-permissions',async(req,reply)=>await options.authorize(req,reply)?reply.type('text/html; charset=utf-8').send(executionCenterHtml):reply);
  app.register(async routes=>{
    routes.addHook('preHandler',async(req,reply)=>{
      if(req.method!=='GET'&&req.headers.origin&&req.headers.origin!==`${req.protocol}://${req.headers.host}`)return reply.code(403).send({error:{code:'origin_forbidden'}});
      if(!await options.authorize(req,reply)&&!reply.sent)return reply.code(403).send({error:{code:'admin_required'}});
    });
    const perform=async(req:FastifyRequest,reply:FastifyReply,work:(actor:string)=>unknown|Promise<unknown>)=>{
      const actor=options.identity(req);if(!actor)return reply.code(401).send({error:{code:'identity_required'}});
      try{return await work(actor);}catch{return reply.code(400).send({error:{code:'execution_policy_failed',messageKey:'実行権限の操作に失敗しました。入力と保存先を確認してください。'}});}
    };
    routes.get('/api/execution-permissions',(req,reply)=>perform(req,reply,()=>({workspace:options.workspace,maintenanceWorkspaces:maintenanceWorkspaces(),...executionSummary() as object,providerData:providerDataSummary(options.providers?.()||[])})));
    routes.put('/api/execution-permissions/defaults',(req,reply)=>perform(req,reply,async actor=>{
      const value=req.body as Record<string,unknown>;
      if(!value||Array.isArray(value)||Object.keys(value).some(key=>!['maintenance','agent','restore'].includes(key)))throw new Error('入力項目が不正です。');
      await configureDefaultExecution(value as Parameters<typeof configureDefaultExecution>[0],actor);options.onAccessChange?.(value.agent as string|undefined);return {ok:true};
    }));
    routes.post('/api/execution-permissions/projects',(req,reply)=>perform(req,reply,async actor=>{
      const value=req.body as Record<string,unknown>;
      if(!value||Array.isArray(value)||Object.keys(value).some(key=>!['root','shareContext','allowHostAccount','expectedTargetsDigest'].includes(key)))throw new Error('入力項目が不正です。');
      await grantProjectExecution(value as Parameters<typeof grantProjectExecution>[0],actor);options.onAccessChange?.();return {ok:true};
    }));
    routes.delete('/api/execution-permissions/projects/:id',(req,reply)=>perform(req,reply,async actor=>{await revokeProjectExecution((req.params as {id:string}).id,actor);return {ok:true};}));
    routes.post('/api/execution-permissions/providers/:provider',(req,reply)=>perform(req,reply,async actor=>{
      const provider=options.providers?.().find(p=>p.id===(req.params as {provider:string}).provider),body=req.body as Record<string,unknown>;
      if(!provider||!body||typeof body.blocked!=='boolean'||typeof body.targetDigest!=='string'||Object.keys(body).some(key=>!['blocked','targetDigest'].includes(key)))throw new Error('Provider送信方針の入力が不正です。');
      if(body.blocked===false&&provider.enabled===false)throw new Error('Provider設定で無効です。');
      await setProviderDataBlocked(provider,body.blocked,body.targetDigest,actor);return {ok:true};
    }));
    routes.post('/api/execution-permissions/grants',(req,reply)=>perform(req,reply,async actor=>{
      const value=req.body as Record<string,unknown>;
      if(!value||typeof value.expectedConnectionDigest!=='string'||Object.keys(value).some(key=>!['agent','root','shareContext','allowHostAccount','hours','expectedConnectionDigest'].includes(key)))throw new Error('入力項目が不正です。');
      await grantExecution(value as unknown as Parameters<typeof grantExecution>[0],actor);return {ok:true};
    }));
    routes.delete('/api/execution-permissions/grants/:agent',(req,reply)=>perform(req,reply,async actor=>{await revokeExecution((req.params as {agent:string}).agent,actor);return {ok:true};}));
  });
}
