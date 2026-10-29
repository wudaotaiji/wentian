import type { FastifyInstance,FastifyRequest,FastifyReply } from 'fastify';
import { maintenanceControlStatus,saveMaintenanceControls,type MaintenanceControlKey } from './maintenance-controls.js';

/** 管理者の明示操作だけで保存・即時反映します。設定変更でDaemonを再起動しません。 */
export function registerMaintenanceControlsRoutes(app:FastifyInstance,authorize:(req:FastifyRequest,reply:FastifyReply)=>unknown,
  onChanged:(keys:MaintenanceControlKey[])=>void|Promise<void>,hardDisabled:()=>boolean=()=>false) {
  const url='/v1/manager/maintenance-controls';
  let applying:Promise<unknown>=Promise.resolve();
  const status=()=>{
    const value=maintenanceControlStatus();
    return {...value,connection:{...value.connection,allowed:!hardDisabled()&&value.connection.allowed,editable:!hardDisabled()},media:{...value.media,editable:true}};
  };
  app.get(url,async(req,reply)=>authorize(req,reply)?status():reply);
  app.put(url,async(req,reply)=>{
    if(!authorize(req,reply))return reply;
    if(req.headers['x-team-virtual-key'] || req.headers.origin&&req.headers.origin!==`${req.protocol}://${req.headers.host}`)
      return reply.code(403).send({error:{message:'同一オリジンの管理画面から操作してください。'}});
    let saved=false;
    try {
      if(hardDisabled()&&(req.body as {connection?:unknown})?.connection===true)return reply.code(409).send({error:{message:'サーバー起動オプションでAgent保守が禁止されています。'}});
      const job=applying.catch(()=>{}).then(async()=>{
        const before=maintenanceControlStatus(),after=await saveMaintenanceControls(req.body);saved=true;
        const keys=(['connection','media'] as const).filter(key=>before[key].allowed!==after[key].allowed);
        await onChanged(keys);
        return { ...status(),message:'実行許可を保存し、稼働中の保守へ反映しました。Daemonの再起動は不要です。' };
      });
      applying=job;return await job;
    }catch(error){return reply.code(saved?500:400).send({saved,error:{message:saved?'実行許可は保存済みですが、稼働中の保守への反映が完了しませんでした。状態を再確認してください。':(error as Error).message}});}
  });
}
