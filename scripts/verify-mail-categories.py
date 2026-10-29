"""Python PlaywrightでAI先行の分類・自由追加・改名・学習連携を検証します。

画面とAPIは実装を使い、AIの応答だけを固定した検証用応答へ置き換えます。
一時データベースで動作させ、本番メールの分類や認証情報を変更しません。
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/evidence/mail-categories/20261010'


def main():
    """隔離サーバーを起動し、利用者と同じ操作で分類変更を確認します。"""
    OUT.mkdir(parents=True, exist_ok=True)
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='wentian-mail-categories-') as temporary:
        # 表示用HTMLだけを本番から複製し、書き込みは一時領域に限定します。
        work = Path(temporary)
        folder = work / '.wentian/site-pages'
        folder.mkdir(parents=True)
        source = ROOT / '.wentian/site-pages/mail-solutions.json'
        (folder / 'mail-solutions.json').write_text(source.read_text(encoding='utf-8-sig'), encoding='utf-8')
        code = """
        import Fastify from 'fastify';
        import {registerSiteAdmin} from './src/public-site.ts';
        import {MailTrainingService,registerMailTraining} from './src/mail-training.ts';
        import {MailOperationsService,registerMailOperations} from './src/mail-operations.ts';
        const app=Fastify(),workspace=process.env.MAIL_CATEGORY_WORK;
        const training=new MailTrainingService(workspace+'/training');
        const operations=new MailOperationsService(workspace+'/operations',training,{propose:async input=>({model:'fixture-ai',content:JSON.stringify({suggestions:[{name:'保守 / 障害対応',profileKind:'other',reason:'障害対応の進捗を報告するメールのためです。'}]})})});
        const source=operations.saveSource({name:'検証メール',type:'archive'},'fixture');
        await operations.ingest(source.id,Buffer.from('From: fixture@example.invalid\\r\\nSubject: Incident follow-up\\r\\nContent-Type: text/plain; charset=utf-8\\r\\n\\r\\nInfrastructure incident follow-up'));
        registerMailTraining(app,()=>true,training);
        registerMailOperations(app,()=>true,operations);
        registerSiteAdmin(app,{workspace,authorize:()=>true,gatewayOrigin:()=>process.env.MAIL_CATEGORY_ORIGIN,design:async()=> '{}'});
        await app.listen({host:'127.0.0.1',port:Number(process.env.MAIL_CATEGORY_PORT)});
        """
        env = {**os.environ, 'MAIL_CATEGORY_WORK': temporary, 'MAIL_CATEGORY_ORIGIN': origin, 'MAIL_CATEGORY_PORT': str(port)}
        with (OUT / 'server.log').open('w', encoding='utf-8') as log:
            process = subprocess.Popen(['node', '--import', 'tsx', '-e', code], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    try:
                        urllib.request.urlopen(origin + '/api/mail-operations', timeout=1).close()
                        break
                    except OSError:
                        if process.poll() is not None:
                            raise RuntimeError('検証サーバーが終了しました。')
                        time.sleep(0.1)
                else:
                    raise RuntimeError('検証サーバーが応答しません。')
                with sync_playwright() as pw:
                    browser = pw.chromium.launch(channel='msedge', headless=True)
                    page = browser.new_page(viewport={'width': 1440, 'height': 1100})
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.goto(origin + '/sites/mail-solutions/')
                    page.locator('#language').select_option('ja')
                    page.locator('[data-page="review"]').click()
                    # 未分類を開くだけでAIが先行判断し、分類とメールを保存します。
                    page.locator('#mailLiveReviewList button').first.click()
                    page.wait_for_function("document.querySelector('#mailCategoryName')?.value === '保守 / 障害対応'")
                    page.get_by_text('AIの理由 / AI reason:', exact=False).wait_for()
                    messages = page.request.get(origin + '/api/mail-operations/messages').json()['items']
                    assert messages[0]['classificationOrigin'] == 'ai'
                    assert not messages[0]['reviewedBy']
                    first_path = messages[0]['labelPath']
                    assert page.request.get(origin + '/api/mail-operations').json()['taxonomyRevision'] == 1
                    page.screenshot(path=str(OUT / 'ai-first.png'), full_page=True)
                    # 新分類を自由入力し、保存前の抽出項目を失わないことも確認します。
                    page.locator('#mailLiveField-description').fill('編集中の説明')
                    page.locator('#mailCategoryName').fill('自由追加 / 運用改善')
                    page.get_by_role('button', name='新しい分類として追加 / Add category', exact=True).click()
                    page.wait_for_function("document.querySelector('#mailLiveCategory').selectedOptions[0].textContent === '自由追加 / 運用改善'")
                    assert page.locator('#mailLiveField-description').input_value() == '編集中の説明'
                    page.locator('#mailCategoryName').fill('自由追加 / 改善提案')
                    page.get_by_role('button', name='選択中の分類名を変更 / Rename category', exact=True).click()
                    page.wait_for_function("document.querySelector('#mailLiveCategory').selectedOptions[0].textContent === '自由追加 / 改善提案'")
                    new_path = page.locator('#mailLiveCategory').input_value().split('/')
                    page.get_by_role('button', name='確認内容を保存', exact=True).click()
                    page.get_by_role('button', name='確認済み分類を学習例へ', exact=True).click()
                    page.wait_for_function("document.querySelector('#mailLiveGlobal').textContent === '保存しました。'")
                    state = page.request.get(origin + '/api/mail-operations').json()
                    assert state['training']['examples']['classification'] == 1
                    message = page.request.get(origin + '/api/mail-operations/messages').json()['items'][0]
                    assert message['labelPath'] == new_path and message['labelPath'] != first_path
                    assert message['fields']['description'] == '編集中の説明'
                    page.reload()
                    page.locator('[data-page="inbox"]').click()
                    page.locator('#mailLiveInboxTable tbody tr').first.click()
                    assert page.locator('#mailLiveCategory').locator('option:checked').inner_text() == '自由追加 / 改善提案'
                    page.screenshot(path=str(OUT / 'custom-category.png'), full_page=True)
                    assert not errors, errors
                    browser.close()
                    result = {'status':'passed','browser':'Python Playwright / Edge','aiResponse':'fixture-only','productionDataModified':False,'checks':['未分類メールを開くとAIが自動判断・分類追加・保存','AI理由表示','自由入力の追加と改名','入力中の抽出項目保持','新分類での確認保存と学習例登録','再読込後の分類保持']}
                    (OUT / 'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
                    print(json.dumps(result,ensure_ascii=False))
            finally:
                process.terminate()
                process.wait(timeout=15)


if __name__ == '__main__':
    main()
