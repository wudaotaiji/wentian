"""架空の知識庫サンプルを、利用者が指定した新規領域へ複製・配信します。

このプログラムはWentianの本番データや設定を変更しません。
配信先はループバックだけに固定し、状態ファイル・認証値はHTTP公開しません。
Python標準ライブラリだけで動作します。PowerShell版も同じ処理を呼び出します。
"""
import argparse
import sys
import hashlib
import html
import json
import mimetypes
import os
import re
from pathlib import Path
import secrets
import shutil
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


# パイプやログ保存時も日本語をUTF-8で出力します。
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

TEMPLATE = Path(__file__).resolve().parent.parent / "examples/knowledge/demo"
MARKER = "wentian-knowledge-demo/1"


def save(file, value):
    """部分的なJSONを読ませないよう、同じディレクトリーで原子的に置換します。"""
    temporary = file.with_name(file.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, file)


def state(directory):
    """誤った保存先を操作せず、このプログラムで作成した領域だけを扱います。"""
    value = json.loads((directory / "state.json").read_text(encoding="utf-8"))
    if value.get("format") != MARKER:
        raise ValueError("サンプル領域ではありません。")
    return value


def profiles(directory, value):
    """内部接続の許可を、この一つの接続元と明示した検証プロジェクトに限定します。"""
    common = {"projects": value["projects"], "origins": [value["origin"]], "allowPrivate": True}
    save(directory / "sources.json", [
        {**common, "id": "demo-public", "headers": {}},
        {**common, "id": "demo-header", "headers": {"authorization": "Bearer " + value["token"]}},
        {**common, "id": "demo-browser", "storageStatePath": str(directory / "browser.storage-state.json"), "selector": "body"},
    ])


class Handler(BaseHTTPRequestHandler):
    """公開ファイルを許可リストで配信し、秘密の設定領域へのパス参照を拒否します。"""
    def log_message(self, *_args):
        # URL、Cookie、認証ヘッダーをログへ出しません。
        pass

    def send(self, code, body, content_type="text/html; charset=utf-8", cookie=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        # ローカルの模擬ログイン。実在の利用者名・パスワードは要求しません。
        if self.path != "/login" or int(self.headers.get("Content-Length", "0")) > 1024:
            return self.send(404, "対象がありません。")
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        value = state(self.server.directory)
        if not value["authActive"]:
            return self.send(401, "模擬認証が停止中です。activateを実行してください。")
        return self.send(200, '<h1>模擬ログイン完了</h1><a href="/private/policy">認証付き規程</a>', cookie="wentian_demo=" + value["token"] + "; HttpOnly; SameSite=Lax; Path=/")

    def do_GET(self):
        directory = self.server.directory
        value = state(directory)
        route = urlparse(self.path).path
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get("Cookie", ""))
        except Exception:
            pass
        authenticated = value["authActive"] and (
            secrets.compare_digest(self.headers.get("Authorization", ""), "Bearer " + value["token"]) or
            ("wentian_demo" in cookies and secrets.compare_digest(cookies["wentian_demo"].value, value["token"]))
        )
        if route.startswith("/private/") and not authenticated:
            return self.send(401, "<h1>認証の更新が必要です</h1>")
        if route == "/login":
            return self.send(200, '<h1>Wentian用の模擬ログイン</h1><p>実アカウントは不要です。</p><form method="post" action="/login"><button>サンプルとしてログイン</button></form>')
        if route in ("/", "/index.html"):
            links = [("/policy", "更新される日本語規程"), ("/plan", "中国語の研修計画"), ("/js", "JavaScriptで本文を生成"), ("/private/policy", "認証付き規程"), ("/private/js", "認証付きJavaScript本文"), ("/crawl", "継続巡回の入口"), ("/login", "模擬ログイン")]
            links += [("/files/" + name, name) for name in self.server.public_files]
            return self.send(200, "<html><head><title>Wentian確認サンプル</title></head><body><h1>架空の星見プロジェクト</h1><ul>" + "".join('<li><a href="' + url + '">' + html.escape(title) + "</a></li>" for url, title in links) + "</ul></body></html>")
        if route in ("/policy", "/private/policy"):
            file = "01-policy-ja-v1.md" if value["revision"] == 1 else "02-policy-ja-v2.md"
            text = (directory / "assets" / file).read_text(encoding="utf-8")
            return self.send(200, '<html><head><title>星見出張規程</title></head><body><article>' + "".join("<p>" + html.escape(line) + "</p>" for line in text.splitlines()) + "</article></body></html>")
        if route == "/plan":
            text = (directory / "assets/03-training-plan-zh.md").read_text(encoding="utf-8")
            return self.send(200, '<html><head><title>星见培训计划</title></head><body><article>' + "".join("<p>" + html.escape(line) + "</p>" for line in text.splitlines()) + "</article></body></html>")
        if route in ("/data", "/private/data"):
            return self.send(200, json.dumps({"text": "JavaScriptで取得した確認値は、受講者4人、研修3日、宿泊2泊です。"}, ensure_ascii=False), "application/json")
        if route in ("/js", "/private/js"):
            endpoint = "/private/data" if route.startswith("/private/") else "/data"
            return self.send(200, '<html><head><title>JavaScript資料</title></head><body><h1>動的な研修情報</h1><div id="article">読込中</div><script>fetch(' + json.dumps(endpoint) + ').then(r=>{if(!r.ok)throw Error();return r.json()}).then(v=>document.getElementById("article").textContent=v.text)</script></body></html>')
        if route == "/crawl" or route in ("/crawl/1", "/crawl/2", "/crawl/3", "/crawl/4"):
            page = int(route.rsplit("/", 1)[-1]) if route != "/crawl" else 0
            link = '<a href="/crawl/' + str(page + 1) + '">次の資料</a>' if page < 4 else "巡回はここで終了です。"
            return self.send(200, "<html><head><title>巡回資料" + str(page) + "</title></head><body><p>確認用の巡回資料 " + str(page) + "</p>" + link + "</body></html>")
        if route.startswith("/files/"):
            name = route[len("/files/"):]
            if name in self.server.public_files:
                file = directory / "assets" / name
                mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
                return self.send(200, file.read_bytes(), mime)
        return self.send(404, "<h1>対象がありません</h1>")


def main():
    parser = argparse.ArgumentParser(description="Wentian機能確認の隔離サンプル")
    parser.add_argument("action", choices=["prepare", "serve", "revision1", "revision2", "expire", "activate", "large", "verify"])
    parser.add_argument("--directory", required=True)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--projects", default="demo-knowledge,demo-media")
    args = parser.parse_args()
    directory = Path(args.directory).resolve()
    if args.action == "prepare":
        # 既存領域へ上書きせず、新しいサンプル専用ディレクトリーだけを作成します。
        if directory.is_relative_to(TEMPLATE.resolve()):
            raise ValueError("配布元の中へは複製できません。別の領域を指定してください。")
        directory.mkdir(parents=False, exist_ok=False, mode=0o700)
        shutil.copytree(TEMPLATE, directory / "assets")
        projects = args.projects.split(",")
        if not projects or any(not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,63}", p) for p in projects):
            raise ValueError("プロジェクト識別名を確認してください。")
        save(directory / "state.json", {"format": MARKER, "revision": 1, "authActive": True, "token": secrets.token_urlsafe(32), "projects": projects})
        print("サンプルを新規領域へ準備しました。次にserveを実行してください。")
        return
    value = state(directory)
    if args.action == "serve":
        if not 0 <= args.port <= 65535:
            raise ValueError("ポートが範囲外です。")
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
        server.directory = directory
        server.public_files = sorted(p.name for p in (directory / "assets").iterdir() if p.is_file() and p.suffix.lower() in (".pdf", ".png", ".wav", ".csv"))
        value["origin"] = "http://127.0.0.1:" + str(server.server_port)
        save(directory / "state.json", value)
        profiles(directory, value)
        (directory / "urls.txt").write_text("\n".join(value["origin"] + suffix for suffix in ["/", "/policy", "/plan", "/js", "/private/policy", "/private/js", "/crawl", "/login"]), encoding="utf-8")
        print("サンプル配信を開始しました: " + value["origin"], flush=True)
        print("収集設定: " + str(directory / "sources.json"), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("サンプル配信を停止します。", flush=True)
        finally:
            server.server_close()
        return
    if args.action == "verify":
        manifest = json.loads((directory / "assets/manifest.json").read_text(encoding="utf-8"))
        for row in manifest["files"]:
            file = directory / "assets" / row["name"]
            if hashlib.sha256(file.read_bytes()).hexdigest() != row["sha256"]:
                raise ValueError("サンプルファイルのハッシュが一致しません。")
        print("サンプルの全ファイルのハッシュを確認しました。")
        return
    if args.action == "large":
        folder = directory / "large"
        folder.mkdir(exist_ok=False)
        # 49,000行を20行ずつ分割すると約2,450チャンク。5件で1万チャンクを超えます。
        # 実モデルで索引を作る場合は、その件数分の推論時間・費用が発生します。
        for index in range(5):
            (folder / ("large-" + str(index + 1) + ".txt")).write_text("資\n" * 49000, encoding="utf-8")
        print("大規模索引用の合成資料5件を作成しました。意味検索の品質採点には使いません。")
        return
    if args.action.startswith("revision"):
        value["revision"] = 1 if args.action == "revision1" else 2
    else:
        value["authActive"] = args.action == "activate"
        if args.action == "activate":
            value["token"] = secrets.token_urlsafe(32)
    save(directory / "state.json", value)
    if "origin" in value:
        profiles(directory, value)
    print("サンプルの版または認証状態を更新しました。Wentianの本番設定は変更していません。")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("サンプル処理に失敗しました。新規保存先、引数、配布ファイルを確認してください。")
        raise SystemExit(1)
