import path from 'node:path';
import { serviceKey, type WentianPluginDefinition } from '../plugin-kernel.js';
import { JupyterStudyService, type StudyModule } from './service.js';

export const STUDY_JUPYTER_SERVICE = serviceKey<{ create(workspace: string, owner?: string): StudyModule }>('wentian.study.jupyter/1');
/** 登録だけではPythonの読込・導入・サーバー起動を行いません。 */
export const studyJupyterPlugin: WentianPluginDefinition<{ root?: string; notebooks?: string }> = {
  id: 'core.study-jupyter', kind: 'ui', version: '1.0.0', provides: [STUDY_JUPYTER_SERVICE],
  setup(context, config) {
    context.provide(STUDY_JUPYTER_SERVICE, { create(workspace, owner) {
      const installRoot = process.env.WENTIAN_INSTALL_ROOT || process.cwd();
      const base = path.resolve(config?.notebooks || process.env.WENTIAN_JUPYTER_NOTEBOOK_ROOT || path.join(workspace, 'notebooks'));
      return new JupyterStudyService(path.resolve(config?.root || process.env.WENTIAN_JUPYTER_MODULE_ROOT || path.join(installRoot, '.wentian/modules/jupyter')), owner ? path.join(base, 'users', owner) : base, owner);
    } });
  },
};
