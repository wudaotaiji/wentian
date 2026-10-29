"""人間向けの外観確認の準備。HTTP応答を確認し、任意で画面を開く。外観合格は判定しない。"""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser


def main():
    # PowerShellへの出力やファイル保存でも日本語をUTF-8で保持する。
    sys.stdout.reconfigure(encoding='utf-8')
    # 接続先は利用者が指定する。認証情報を取得したり設定を変更したりしない。
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:8787')
    parser.add_argument('--open', action='store_true', help='既定ブラウザで確認対象を開く')
    args = parser.parse_args()
    base = args.base_url.rstrip('/')
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        parser.error('認証情報を含まないHTTP/HTTPSのURLを指定してください。')
    # 未認証の401/403や認証画面への遷移は外観不良と判定しない。
    # 上流モデルが不調な場合、healthの503と画面表示の成否は別々に判断する。
    rows = []
    for route in ('/health', '/operations', '/workflows', '/projects'):
        url = base + route
        try:
            with urllib.request.urlopen(url, timeout=10) as response:
                rows.append({'url': url, 'status': response.status, 'finalUrl': response.url})
        except urllib.error.HTTPError as error:
            rows.append({'url': url, 'status': error.code, 'finalUrl': error.url})
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            rows.append({'url': url, 'error': str(error)})
        # 起動先はPython標準の既定ブラウザ。Edge固定は文書の手動手順を使う。
        if args.open and route != '/health':
            webbrowser.open_new_tab(url)
    print(json.dumps({'results': rows, 'visualAcceptance': '人間による確認待ち'}, ensure_ascii=False, indent=2))
    return 1 if any('error' in row for row in rows) else 0


if __name__ == '__main__':
    raise SystemExit(main())
