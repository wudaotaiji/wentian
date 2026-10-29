"""Python Playwrightで5種類のメールスタイルと自動取得状態表示を検証します。

一時フォルダー・一時ポートを使用するため、稼働中のメール設定を変更しません。
保存済みのHTMLだけを参照し、メール本文や接続先の認証情報は読みません。
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
OUT = ROOT / 'docs/evidence/mail-live/20261010'


def main():
    """実装済みルートを隔離サーバーで起動し、画面操作と保存を確認します。"""
    OUT.mkdir(parents=True, exist_ok=True)
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='wentian-mail-styles-') as temporary:
        # 本番の保存済み画面を読みますが、書き込み先は一時領域に限定します。
        source = ROOT / '.wentian/site-pages/mail-solutions.json'
        site = json.loads(source.read_text(encoding='utf-8-sig'))
        work = Path(temporary)
        folder = work / '.wentian/site-pages'
        folder.mkdir(parents=True)
        (folder / 'mail-solutions.json').write_text(json.dumps(site), encoding='utf-8')
        server_code = """
        import Fastify from 'fastify';
        import {registerSiteAdmin} from './src/public-site.ts';
        import {withSiteEditor} from './src/site-editor-ui.ts';
        import {MailTrainingService,registerMailTraining} from './src/mail-training.ts';
        import {MailOperationsService,registerMailOperations} from './src/mail-operations.ts';
        const app=Fastify(),workspace=process.env.MAIL_STYLE_WORK;
        const training=new MailTrainingService(workspace+'/training');
        const operations=new MailOperationsService(workspace+'/operations',training);
        operations.repository.put('source',{name:'自動取得の表示確認',type:'imap',enabled:false,status:'idle',intervalSeconds:300,checkpoints:{},lastSync:'2026-10-08T13:15:36.836Z',folders:['INBOX']});
        registerMailTraining(app,()=>true,training);
        registerMailOperations(app,()=>true,operations);
        registerSiteAdmin(app,{workspace,authorize:()=>true,gatewayOrigin:()=>process.env.MAIL_STYLE_ORIGIN,design:async()=> '{}'});
        app.get('/api/control-center/me',()=>({user:{role:'admin'}}));
        app.get('/admin',(_req,reply)=>reply.type('text/html; charset=utf-8').send(withSiteEditor('<html><head><meta charset="utf-8"></head><body><main></main></body></html>')));
        await app.listen({host:'127.0.0.1',port:Number(process.env.MAIL_STYLE_PORT)});
        """
        env = {**os.environ, 'MAIL_STYLE_WORK': temporary, 'MAIL_STYLE_ORIGIN': origin, 'MAIL_STYLE_PORT': str(port)}
        with (OUT / 'styles-server.log').open('w', encoding='utf-8') as log:
            process = subprocess.Popen(['node', '--import', 'tsx', '-e', server_code], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    try:
                        urllib.request.urlopen(origin + '/api/mail-operations', timeout=1).close()
                        break
                    except OSError:
                        if process.poll() is not None:
                            raise RuntimeError('検証サーバーの起動に失敗しました。')
                        time.sleep(0.1)
                else:
                    raise RuntimeError('検証サーバーが応答しません。')
                with sync_playwright() as pw:
                    browser = pw.chromium.launch(channel='msedge', headless=True)
                    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.on('dialog', lambda dialog: dialog.accept())
                    page.goto(origin + '/sites/mail-solutions/')
                    page.locator('#language').select_option('ja')
                    picker = page.locator('#mailSiteStyle')
                    assert picker.locator('option').count() == 5
                    colors = {}
                    for theme in ('light', 'dark', 'glass', 'bento', 'minimal'):
                        picker.select_option(theme)
                        assert page.locator('html').get_attribute('data-mail-style') == theme
                        colors[theme] = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()")
                        page.screenshot(path=str(OUT / f'style-{theme}.png'), full_page=True)
                    assert len(set(colors.values())) >= 4
                    page.reload()
                    assert picker.input_value() == 'minimal'
                    page.locator('[data-page="sources"]').click()
                    page.locator('[data-mail-auto-fetch="disabled"]').wait_for()
                    assert '最終同期' in page.locator('#mailLiveSourceList').inner_text()
                    page.screenshot(path=str(OUT / 'auto-fetch-disabled.png'), full_page=True)
                    # 狭い画面でも選択肢と本文が横にはみ出さないことを確認します。
                    page.set_viewport_size({'width': 390, 'height': 844})
                    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                    page.screenshot(path=str(OUT / 'style-mobile.png'), full_page=True)
                    page.set_viewport_size({'width': 1440, 'height': 1000})
                    page.goto(origin + '/admin')
                    page.locator('#sitePage').select_option('mail-solutions')
                    page.wait_for_function("document.querySelector('#siteEditor').classList.contains('site-document-mode') && document.querySelectorAll('#siteTheme option').length === 5")
                    page.locator('#siteTheme').wait_for(state='visible')
                    assert page.locator('#siteTheme option').count() == 5
                    page.locator('#siteTheme').select_option('dark')
                    page.locator('#siteSave').click()
                    try:
                        page.wait_for_function("document.querySelector('#siteStatus').textContent.includes('保存して公開しました')", timeout=10000)
                    except Exception:
                        print(json.dumps({'保存状態': page.locator('#siteStatus').inner_text(), '無効項目': page.locator(':invalid').evaluate_all('els=>els.map(e=>({id:e.id,message:e.validationMessage}))')}, ensure_ascii=False))
                        raise
                    assert page.request.get(origin + '/api/site-admin?page=mail-solutions').json()['site']['theme'] == 'dark'
                    # ブラウザ個別設定を消し、保存した共通の初期スタイルを確認します。
                    page.evaluate("localStorage.removeItem('wentian-mail-style')")
                    page.goto(origin + '/sites/mail-solutions/')
                    assert page.locator('html').get_attribute('data-mail-style') == 'dark'
                    assert not errors, errors
                    browser.close()
                    result = {'status': 'passed', 'browser': 'Python Playwright / Edge', 'checks': ['5種類の選択と外観', '再読込後の選択保持', '自動取得の無効表示と最終同期', 'モバイル表示', '管理画面の5種類選択・保存と初期スタイル反映'], 'productionDataModified': False}
                    (OUT / 'styles-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
                    print(json.dumps(result, ensure_ascii=False))
            finally:
                process.terminate()
                process.wait(timeout=15)


if __name__ == '__main__':
    main()
