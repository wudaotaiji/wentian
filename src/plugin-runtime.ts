import type { WentianPluginKernel } from './plugin-kernel.js';

let activeKernel: WentianPluginKernel | undefined;

/** Process内の現在Runtimeを公開し、既存コードを段階的にService Consumerへ移行できるようにします。 */
export function setActivePluginKernel(kernel: WentianPluginKernel | undefined): void { activeKernel = kernel; }
export function getActivePluginKernel(): WentianPluginKernel | undefined { return activeKernel; }
