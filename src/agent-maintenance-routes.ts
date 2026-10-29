import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ExternalAgentReadinessManager } from './external-agent-readiness.js';
import { readAIMaintenanceReports } from './agent-ai-maintenance.js';
import { executionAccessSummary } from './execution-governance.js';

/** 設定・開始・停止・手動実行を一つの管理APIへまとめます。変更は管理者に限定します。 */
export function registerAgentMaintenanceRoutes(app: FastifyInstance, manager: ExternalAgentReadinessManager,
  authorize: (req: FastifyRequest, reply: FastifyReply) => unknown) {
  const url = '/v1/manager/external-agents/maintenance';
  app.get(url + '/ai', async (req, reply) => {
    if (!authorize(req, reply)) return reply;
    return { version: 1, engine: 'ai', reports: await readAIMaintenanceReports() };
  });
  app.get(url, async () => {
    const status=manager.refreshResourceStatus?await manager.refreshResourceStatus():manager.maintenanceStatus();
    try {const access=executionAccessSummary();return {...status,executionAccess:{maintenanceDefault:access.maintenanceDefault,maintenanceEnvironmentBlocked:access.maintenanceEnvironmentBlocked,revokedAgents:access.revokedAgents}};}
    catch{return {...status,executionAccess:{maintenanceDefault:false,policyError:true}};}
  });
  app.post(url, async (req, reply) => {
    if (!authorize(req, reply)) return reply;
    try {
      const body = (req.body || {}) as { action?: string; settings?: unknown };
      if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['action', 'settings'].includes(key))) throw new Error('保守操作の形式が不正です。');
      // 旧版の空リクエストは全体開始として互換性を保ちます。
      const action = body.action || 'start';
      if (action === 'start') await manager.configureMaintenance({ enabled: true });
      else if (action === 'stop') await manager.configureMaintenance({ enabled: false });
      else if (action === 'configure') await manager.configureMaintenance(body.settings);
      else if (action === 'run') manager.requestMaintenance();
      else throw new Error('保守操作はstart・stop・configure・runから指定してください。');
      return reply.code(202).send(manager.maintenanceStatus());
    } catch (error) {
      return reply.code(manager.maintenanceStatus().state === 'disabled' ? 409 : 400).send({ error: { message: (error as Error).message } });
    }
  });
}
