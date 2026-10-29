import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { withAppearance } from './appearance-ui.js';
import { managerDashboardHtml } from './dashboard.js';
import { workbenchHtml } from './workbench-ui.js';
import { groupManagementHtml } from './group-management-ui.js';
import { mediaProductionHtml } from './media-production-ui.js';
import { videoGenerationHtml } from './video-generation-ui.js';
import { personalCloudHtml } from './personal-cloud/ui.js';
import { cloudFederationHtml } from './cloud-federation/ui.js';
import { studyHtml } from './study/ui.js';
import { visualAssetsHtml } from './visual-assets-ui.js';
import { workflowCenterHtml } from './workflow-center.js';
import { plannerTrainingPage } from './planner-training-ui.js';

// 実サービスへ接続せず、自製9画面の静的文言を横断確認します。
for (const [name, source] of Object.entries({ workflows: workflowCenterHtml, training: plannerTrainingPage(), home: managerDashboardHtml, workbench: workbenchHtml, groups: groupManagementHtml, media: mediaProductionHtml, video: videoGenerationHtml, cloud: personalCloudHtml, federation: cloudFederationHtml, study: studyHtml, assets: visualAssetsHtml })) {
  test(`${name}の英語表示に日本語・中国語の固定文言を残さない`, async () => {
    const window = new Window({ url: 'http://localhost/' });
    window.localStorage.setItem('wentian-language', 'en');
    try {
      const html = withAppearance(source);
      window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
      const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(m => m[1].includes('window.wentianUi={t,apply,language}'))!;
      window.eval(script[1]);
      const remaining = new Set<string>();
      const walker = window.document.createTreeWalker(window.document.body, 4);
      let node;
      while ((node = walker.nextNode())) {
        if (node.parentElement!.closest('script,style,pre,code,textarea,#language,[data-no-translate]')) continue;
        const text = node.textContent!.trim();
        if (/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) remaining.add(text);
      }
      assert.deepEqual([...remaining], [], '未翻訳の固定文言');
      for (const element of window.document.querySelectorAll('[placeholder],[aria-label],[title]')) {
        if (element.closest('#language,[data-no-translate]')) continue;
        for (const key of ['placeholder', 'aria-label', 'title']) {
          const value = element.getAttribute(key) || '';
          if (/[\u3040-\u30ff\u3400-\u9fff]/.test(value)) remaining.add(value);
        }
      }
      assert.deepEqual([...remaining], [], '未翻訳の入力例・アクセシビリティ説明');
    } finally { await window.happyDOM.close(); }
  });
}
