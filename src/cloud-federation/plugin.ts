import path from 'node:path';
import { serviceKey, type WentianPluginDefinition } from '../plugin-kernel.js';
import { createAIReviewer, createA2ADecider, type AIReviewOptions } from './ai-review.js';
import { digestAdapter } from './adapters.js';
import { FederationService, type FederationOptions } from './service.js';
import type { ExecutionAdapter } from './contracts.js';

export interface CloudFederationFactory {
  open(options?: Partial<FederationOptions> & { complete?: AIReviewOptions['complete'] }): Promise<FederationService>;
}
export const CLOUD_FEDERATION_SERVICE = serviceKey<CloudFederationFactory>('wentian.cloud.federation');
export const CLOUD_ADAPTERS_SERVICE = serviceKey<() => ExecutionAdapter[]>('wentian.cloud.adapters');
export const CLOUD_AI_REVIEW_SERVICE = serviceKey<typeof createAIReviewer>('wentian.cloud.ai-review');

/** 読込だけでは鍵生成・外部接続を開始せず、実行とAI判断を別々に交換できます。 */
export function cloudFederationPlugins(): WentianPluginDefinition[] {
  return [
    { id: 'core.cloud-adapters', kind: 'runner', version: '0.1.0', provides: [CLOUD_ADAPTERS_SERVICE], setup(context) { context.provide(CLOUD_ADAPTERS_SERVICE, () => [digestAdapter()]); } },
    { id: 'core.cloud-ai-review', kind: 'planner', version: '0.1.0', provides: [CLOUD_AI_REVIEW_SERVICE], setup(context) { context.provide(CLOUD_AI_REVIEW_SERVICE, createAIReviewer); } },
    {
      id: 'core.cloud-federation', kind: 'tool', version: '0.1.0', requires: ['core.cloud-adapters', 'core.cloud-ai-review'], provides: [CLOUD_FEDERATION_SERVICE],
      setup(context, raw) {
        const config = (raw || {}) as { directory?: string; reviewModel?: string };
        context.provide(CLOUD_FEDERATION_SERVICE, {
          open(options = {}) {
            return FederationService.open({
              directory: options.directory || config.directory || process.env.WENTIAN_FEDERATION_HOME || path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), '.wentian', 'federation'),
              reviewer: options.reviewer || context.resolve(CLOUD_AI_REVIEW_SERVICE)({ model: config.reviewModel || process.env.WENTIAN_FEDERATION_REVIEW_MODEL, complete: options.complete }),
              adapters: options.adapters || context.resolve(CLOUD_ADAPTERS_SERVICE)(),
              transport: options.transport, observe: options.observe, now: options.now,
              a2aDecide: options.a2aDecide || createA2ADecider({ model: config.reviewModel || process.env.WENTIAN_FEDERATION_REVIEW_MODEL, complete: options.complete }),
              groupWorkspace: options.groupWorkspace || process.env.WENTIAN_TASK_WORKSPACE || process.cwd(),
            });
          },
        });
      },
    },
  ];
}
