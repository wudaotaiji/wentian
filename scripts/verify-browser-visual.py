"""実Edgeの外観検収用。通常認証、画面画像、横方向のはみ出し、JavaScriptエラーを記録する。"""
import argparse
import datetime
import json
import os
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:8787')
    parser.add_argument('--env-file', default='.env')
    parser.add_argument('--output', default='docs/evidence/browser-visual')
    parser.add_argument('--headed', action='store_true', help='Edgeウィンドウを表示する')
    parser.add_argument('--manual-login', action='store_true', help='Edge画面で手動ログインを最大5分待つ')
    args = parser.parse_args()
    # 指定環境ファイルから認証に必要な2項目のみ取得。標準出力・報告・画像には値を載せない。
    settings = dict(os.environ)
    env_path = Path(args.env_file)
    if env_path.exists():
        for line in env_path.read_text(encoding='utf-8-sig').splitlines():
            key, sep, value = line.strip().removeprefix('export ').partition('=')
            if sep and key in ('WENTIAN_ADMIN_USERNAME', 'WENTIAN_ADMIN_PASSWORD'):
                settings.setdefault(key, value.strip().strip('\"\''))
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'browser': 'msedge', 'checks': []}
    with sync_playwright() as playwright:
        # 既存ユーザープロファイルへ接続しない。ブラウザ本体は導入済みEdgeを使う。
        browser = playwright.chromium.launch(channel='msedge', headless=not (args.headed or args.manual_login))
        report['browserVersion'] = browser.version
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, locale='ja-JP')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        # 認証を無効化せず、既存の通常ログインAPIを利用。パスワードは記録しない。
        username = settings.get('WENTIAN_ADMIN_USERNAME')
        password = settings.get('WENTIAN_ADMIN_PASSWORD')
        if username and password:
            response = context.request.post(args.base_url.rstrip('/') + '/api/control-center/login', data={'username': username, 'password': password})
            report['loginStatus'] = response.status
        else:
            report['loginStatus'] = '既存管理者の認証情報が設定にありません'
        if args.manual_login:
            # パスワードをチャットへ要求せず、利用者が専用Edgeの通常フォームへ入力する。
            # 毎秒のセッション確認だけを行い、認証情報やCookieは保存しない。
            page.goto(args.base_url.rstrip('/') + '/', wait_until='domcontentloaded')
            print('開いたEdgeで管理者ログインを行ってください。最大5分待機します。', flush=True)
            import time
            deadline = time.monotonic() + 300
            while time.monotonic() < deadline:
                probe = context.request.get(args.base_url.rstrip('/') + '/api/control-center/me')
                if probe.ok and probe.json().get('user', {}).get('role') == 'admin':
                    report['loginStatus'] = '管理者の手動ログイン成功'
                    break
                page.wait_for_timeout(1000)
        # 本番データを作成・変更せず、3画面を大画面とスマートフォン相当幅で閲覧する。
        for width, height in ((1440, 1000), (390, 844)):
            page.set_viewport_size({'width': width, 'height': height})
            for route in ('operations', 'workflows', 'projects'):
                errors.clear()
                response = page.goto(args.base_url.rstrip('/') + '/' + route, wait_until='networkidle', timeout=30000)
                page.evaluate('document.fonts.ready')
                filename = f'{route}-{width}.png'
                page.screenshot(path=str(output / filename), full_page=True)
                # DOM（Document Object Model）の実寸を観測。画像の目視確認は別途実施する。
                metrics = page.evaluate('''() => ({title:document.title, heading:document.querySelector('h1')?.textContent,
                    width:innerWidth, scrollWidth:document.documentElement.scrollWidth,
                    notice:document.querySelector('#notice')?.textContent,
                    overflowing:[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left< -1)}).slice(0,20).map(e=>({tag:e.tagName,id:e.id}))})''')
                report['checks'].append({'route': route, 'viewport': [width, height], 'status': response.status if response else None, 'screenshot': filename, 'pageErrors': list(errors), **metrics})
        browser.close()
    report['visualReview'] = '保存画像の目視確認待ち'
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if all(check['status'] == 200 and not check['pageErrors'] for check in report['checks']) else 1


if __name__ == '__main__':
    raise SystemExit(main())
