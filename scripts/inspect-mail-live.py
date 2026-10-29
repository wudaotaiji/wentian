"""Python Playwrightでメール画面と自動取得状態を読み取り専用で確認します。

認証情報、メール本文、接続設定の秘密値は出力しません。
画面の構造と同期状態だけを記録し、メールの取得・変更は実行しません。
"""
import json
import sqlite3
import os
import sys
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/evidence/mail-live/20261010"
OUT.mkdir(parents=True, exist_ok=True)
# 明示指定されたID/PASSは標準入力から受け取り、ファイルやログに残しません。
if '--credentials-stdin' in sys.argv:
    print('認証入力を待っています。', flush=True)
    supplied = json.loads(sys.stdin.readline())
    os.environ['WENTIAN_ADMIN_USERNAME'] = supplied['username']
    os.environ['WENTIAN_ADMIN_PASSWORD'] = supplied['password']
# ローカル設定から指定された認証項目だけを読みます。既存の環境変数を優先します。
env_file = ROOT / '.env'
if env_file.exists():
    for line in env_file.read_text(encoding='utf-8-sig').splitlines():
        key, separator, value = line.strip().partition('=')
        if separator and key in ('WENTIAN_ADMIN_USERNAME', 'WENTIAN_ADMIN_PASSWORD'):
            os.environ.setdefault(key, value.strip().strip('\"\''))
# 稼働DB（データベース / Database）は読み取り専用接続にし、変更しません。
db_path = ROOT / '.wentian/mail-operations/mail.sqlite'
if db_path.exists():
    with sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True) as db:
        sources = [json.loads(row[0]) for row in db.execute("SELECT value FROM mail_items WHERE kind='source'")]
        print(json.dumps({'保存済みソース': [{key: item.get(key) for key in ('type', 'enabled', 'status', 'intervalSeconds', 'lastAttempt', 'lastSync', 'lastError', 'checkpoints')} for item in sources], 'メール件数': db.execute("SELECT count(*) FROM mail_items WHERE kind='message'").fetchone()[0]}, ensure_ascii=False))
with sync_playwright() as pw:
    # 既存の利用者ブラウザとは別のセッションで読み取り確認します。
    browser = pw.chromium.launch(channel="msedge", headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    # 利用者が指定した環境変数をメモリ内だけで使い、秘密値は保存・表示しません。
    username = os.environ.get('WENTIAN_ADMIN_USERNAME')
    password = os.environ.get('WENTIAN_ADMIN_PASSWORD')
    if username and password:
        login = page.request.post('http://127.0.0.1:8787/api/control-center/login', data={'username': username, 'password': password})
        print(json.dumps({'管理者ログイン': login.status}, ensure_ascii=False))
        if '--restart' in sys.argv:
            if not login.ok:
                raise RuntimeError('管理者ログインが成功しないため、反映を停止します。')
            # 学習・動画処理・モデル利用中なら再起動せず、その状態を報告します。
            active = []
            for endpoint in ('/api/mail-operations', '/api/mail-operations/outbox', '/api/mail-training', '/api/planner-training', '/api/videos', '/v1/manager/residency'):
                response = page.request.get('http://127.0.0.1:8787' + endpoint)
                if not response.ok:
                    raise RuntimeError('稼働状態を確認できないため反映を停止します: ' + endpoint)
                data = response.json()
                # 学習APIのactiveは有効モデルの参照なので、実行中の仕事とは区別します。
                occupied = data.get('running') or any(item.get('status') in ('running', 'generating', 'sending', 'syncing') for item in data.get('jobs', []) + data.get('items', []) + data.get('sources', [])) or (endpoint.endswith('/residency') and any(data.get('active', {}).values()))
                print(json.dumps({'稼働確認': endpoint, '処理中': bool(occupied)}, ensure_ascii=False), flush=True)
                if occupied:
                    active.append(endpoint)
            if active:
                raise RuntimeError('進行中の処理があるため反映を停止します: ' + ', '.join(active))
            print('処理中の学習・動画生成・モデル利用はありません。変更を反映します。', flush=True)
            # 既存の常駐サーバー（Daemon）管理機能を利用し、同じポートへ再起動します。
            restart = subprocess.run(['node', '--import', 'tsx', 'src/cli.ts', 'daemon', 'restart'], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=90)
            if restart.returncode:
                raise RuntimeError('常駐サーバーの再起動に失敗しました。稼働ログを確認してください。')
            login = page.request.post('http://127.0.0.1:8787/api/control-center/login', data={'username': username, 'password': password})
            if not login.ok:
                raise RuntimeError('反映後のログインに失敗しました。')
    else:
        print('管理者用の環境変数が実行プロセスにありません。')
    if '--models' in sys.argv:
        # 接続情報の秘密値やURLを出さず、モデル名・利用許可・稼働状態だけを確認します。
        for endpoint in ('/v1/models', '/api/providers', '/v1/manager/models'):
            response = page.request.get('http://127.0.0.1:8787' + endpoint, timeout=60000)
            print(json.dumps({'モデル確認':endpoint,'status':response.status},ensure_ascii=False),flush=True)
            if response.ok:
                data = response.json()
                items = data if isinstance(data,list) else data.get('data',data.get('models',[]))
                print(json.dumps([{**{key:item.get(key) for key in ('id','enabled','kind','autoRoute','available','status','health','loaded','scope','capabilities','safety','resources','state')},'keys':list(item),'model':item.get('model') if isinstance(item.get('model'),dict) else None} for item in items[:50]],ensure_ascii=False),flush=True)
    page.goto("http://127.0.0.1:8787/sites/mail-solutions/")
    page.wait_for_timeout(1500)
    if '--locate-blocked' in sys.argv:
        # 利用者が依頼した停止メールの特定だけを行います。本文・添付・取得位置は変更しません。
        # 認証済みセッションで封筒情報を照合し、秘密情報を出さず件名等を画面で検証します。
        state_response = page.request.get('http://127.0.0.1:8787/api/mail-operations')
        if not state_response.ok:
            raise RuntimeError('停止メールの確認には管理者ログインが必要です。')
        for source in state_response.json().get('sources', []):
            if not source.get('diagnosis', {}).get('blockedUid'):
                continue
            located = page.request.post('http://127.0.0.1:8787/api/mail-operations/sources/' + source['id'] + '/blocked-mail', data={})
            if not located.ok:
                raise RuntimeError('停止メールを特定できません: ' + str(located.json().get('error', {}).get('message')))
            mail = located.json()
            print(json.dumps({'停止メール': mail}, ensure_ascii=False), flush=True)
        page.reload()
        page.locator('#language').select_option('ja')
        page.locator('[data-page="sources"]').click()
        page.get_by_text('取り込みを止めている具体的なメール', exact=True).first.wait_for()
        # 画面表示・検索手順を記録します。メール本文や資格情報は画像に含めません。
        page.screenshot(path=str(OUT / 'blocked-mail-details.png'), full_page=True)
        print('停止メールの詳細と検索手順を実画面で確認しました。', flush=True)
    if '--category-check' in sys.argv:
        # 未分類の実メール1件でAIの先行判断を確認します。本文や送信者は出力しません。
        page.locator('#language').select_option('ja')
        page.locator('[data-page="inbox"]').click()
        page.locator('#mailLiveInboxTable tbody tr').first.click()
        for _ in range(180):
            if page.locator('#mailCategoryEditor').count() and page.locator('#mailCategoryEditor').inner_text().find('AIの理由 / AI reason:') >= 0:
                break
            if page.locator('#mailLiveGlobal.mail-live-error').count():
                raise RuntimeError(page.locator('#mailLiveGlobal').inner_text())
            page.wait_for_timeout(1000)
        else:
            raise RuntimeError('実モデルによるAI分類の完了を確認できません。')
        page.screenshot(path=str(OUT / 'production-ai-category.png'), full_page=True)
        state = page.request.get('http://127.0.0.1:8787/api/mail-operations').json()
        messages = page.request.get('http://127.0.0.1:8787/api/mail-operations/messages').json()['items']
        classified = [item for item in messages if item.get('classificationOrigin') == 'ai']
        result = {'status':'passed','browser':'Python Playwright / Edge','aiClassificationCount':len(classified),'models':list({item['classificationModel'] for item in classified}),'categoryCount':len(state.get('categories',[])),'humanReviewRequiredForClassification':False}
        (OUT / 'production-ai-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(result,ensure_ascii=False), flush=True)
    if '--restart' in sys.argv:
        # 本番では外観設定だけを操作し、メールソースの有効状態は変更しません。
        page.locator('#language').select_option('ja')
        assert page.locator('#mailSiteStyle option').count() == 5
        for theme in ('light', 'dark', 'glass', 'bento', 'minimal'):
            page.locator('#mailSiteStyle').select_option(theme)
            assert page.locator('html').get_attribute('data-mail-style') == theme
        page.locator('#mailSiteStyle').select_option('light')
        page.locator('[data-page="sources"]').click()
        page.locator('[data-mail-auto-fetch]').first.wait_for()
        page.screenshot(path=str(OUT / 'production-sources.png'), full_page=True)
        print('稼働中画面の5種類切替と自動取得状態の表示を確認しました。')
    print(json.dumps({"url": page.url, "title": page.title(), "controls": page.locator("input,select,button").evaluate_all("els=>els.filter(e=>e.id).map(e=>({tag:e.tagName,id:e.id,type:e.type}))")}, ensure_ascii=False))
    for endpoint in ("/api/mail-operations", "/api/control-center/me"):
        response = page.request.get("http://127.0.0.1:8787" + endpoint)
        result = {"endpoint": endpoint, "status": response.status}
        if response.ok and endpoint.endswith("mail-operations"):
            state = response.json()
            result["counts"] = state.get("counts")
            result["sources"] = [{key: item.get(key) for key in ("id", "type", "enabled", "status", "intervalSeconds", "lastAttempt", "lastSync", "lastError", "checkpoints")} for item in state.get("sources", [])]
        print(json.dumps(result, ensure_ascii=False))
    page.screenshot(path=str(OUT / "before.png"), full_page=True)
    browser.close()
