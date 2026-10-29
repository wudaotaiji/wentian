#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Confluence ページを REST API（HTTP Basic 認証）で読み取り専用取得するツール。

背景（なぜ新Madeするのか）
  既存の scripts/get-confluence-pages.py は Playwright でログイン画面から操作するため、
  ・ブラウザ起動コストと時間がかかる
  ・セッション状態ファイル（.wentian/confluence-auth.json）を扱う誤りリスクがある
  という問題があった。Confluence Server/Data Center は REST API
  （/rest/api/content/<id>?expand=...）が Basic 認証で直接使えるため、
  読み取り専用ならこちらの方が安く、確定的で、再実行可能。

秘密情報の扱い（最重要の設計方針）
  ・ユーザー名とパスワードは「環境変数」または「コマンドライン引数」で受け取る。
  ・本スクリプトは認証情報を決してファイルへ書き込まない、標準出力へ表示しない、
    例外メッセージにも載せない。
  ・保存するのはレスポンス本文（ページ JSON と、本文からタグを落としたテキスト）だけ。
  ・既存のセッション状態ファイル（confluence-auth.json）は一切読まない・書かない。

終了コードの契約（リポジトリ内の他検証スクリプトと揃える）
  0 = 要求したページをすべて取得できた
  2 = 一部未取得（権限・存在しないページなど。失敗ではなく検収待ちとして扱う）
  1 = 実行失敗（接続できない、引数不正、認証setup不可）
"""
from __future__ import annotations

import argparse
import base64
import html
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# 接続先は環境変数または引数から受け取り、特定組織のホストを固定しません。
DEFAULT_BASE_URL = os.environ.get("WENTIAN_CONFLUENCE_BASE_URL", "")
# 本文・スペース・版 information を一度で取るための expand 指定
DEFAULT_EXPAND = "body.storage,space,version,metadata.labels"
# HTML をテキスト化するときに取り除くタグ（Mermaid マクロ等は AC:xxx 名前空間タグになる）
TAG_PATTERN = re.compile(r"<[^>]+>")
# 連続空白・空行を詰める
SPACE_PATTERN = re.compile(r"[ \t\xa0]+")
BLANK_LINE_PATTERN = re.compile(r"\n{3,}")


def strip_html(markup: str) -> str:
    """Confluence の storage format（HTML 系）を読み取り専用テキストへ変換する。

    テーブルセル（<td>/<th>）は「 | 」、行末（</tr>）とブロック末（</p></li></h1>...）は
    改行に置換してからタグを落とす。これで表構造がだいたい読み取れる。
    """
    text = markup
    # <br> は明示的に改行へ
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    # 表のセル区切りと行末を通す（Markdown の表に寄せる）
    text = re.sub(r"(?i)</t[dh]>", " | ", text)
    text = re.sub(r"(?i)</tr>", "\n", text)
    # ブロック要素の終わりは改行
    text = re.sub(r"(?i)</(p|li|h[1-6]|div|pre|table|tbody|thead|ul|ol)>", "\n", text)
    # 残ったタグ（マクロ用の名前空間タグ含む）をまとめて除去
    text = TAG_PATTERN.sub("", text)
    # 実体参照を戻して空白を整える
    text = html.unescape(text)
    text = SPACE_PATTERN.sub(" ", text)
    text = BLANK_LINE_PATTERN.sub("\n\n", text)
    return text.strip()


def fetch_page(base_url: str, page_id: str, token: str, expand: str, timeout: int) -> tuple[int, bytes]:
    """1 ページを REST で取得する。戻り値は (HTTPステータス, 生バイト列)。

    401/403 は例外として投げずにステータスで返し、呼び出し側で「検収待ち」扱いにする。
    """
    url = f"{base_url.rstrip('/')}/rest/api/content/{page_id}?expand={expand}"
    request = urllib.request.Request(url, method="GET")
    # Authorization ヘッダーにだけ秘密を含める。この値をログに出さないこと。
    request.add_header("Authorization", f"Basic {token}")
    request.add_header("Accept", "application/json")
    request.add_header("User-Agent", "wentian-gateway/confluence-readonly-fetch")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        # エラー本文に秘密は含まれないが、念のため先頭だけ表示に使う
        body = error.read()
        return error.code, body


def summarize(raw: dict[str, Any]) -> dict[str, Any]:
    """ページ JSON から監査に必要なメタ情報だけを抜き出す（秘密は含まれない）。"""
    version = raw.get("version") or {}
    space = raw.get("space") or {}
    body = (raw.get("body") or {}).get("storage") or {}
    return {
        "id": raw.get("id"),
        "title": raw.get("title"),
        "spaceKey": space.get("key"),
        "spaceName": space.get("name"),
        "version": version.get("number"),
        "versionWhen": version.get("when"),
        "versionBy": (version.get("by") or {}).get("displayName"),
        "versionMessage": version.get("message"),
        "webuiLink": raw.get("_links", {}).get("webui"),
        "labels": [label.get("name") for label in (raw.get("metadata", {}).get("labels", {}) or {}).get("results", [])],
        "bodyText": strip_html(body.get("value", "")),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Confluence ページを REST API（Basic 認証）で読み取り専用取得する",
    )
    parser.add_argument("--page-id", action="append", required=True,
                        help="取得するページ ID（複数指定可: --page-id 1 --page-id 2）")
    parser.add_argument("--base-url", default=os.environ.get("WENTIAN_CONFLUENCE_BASE_URL", DEFAULT_BASE_URL),
                        help=f"Confluence ベース URL（既定 {DEFAULT_BASE_URL}）")
    parser.add_argument("--username", default=os.environ.get("CONFLUENCE_USERNAME", ""),
                        help="ユーザー名（既定は環境変数 CONFLUENCE_USERNAME。引数で渡すとシェル履歴に残る）")
    parser.add_argument("--password", default=os.environ.get("CONFLUENCE_PASSWORD", ""),
                        help="パスワード（既定は環境変数 CONFLUENCE_PASSWORD。環境変数を推奨）")
    parser.add_argument("--expand", default=os.environ.get("CONFLUENCE_EXPAND", DEFAULT_EXPAND),
                        help=f"REST の expand 指定（既定 {DEFAULT_EXPAND}）")
    parser.add_argument("--output-dir", required=True,
                        help="保存先ディレクトリ（Git 除外済みの .wentian/ 配下を推奨）")
    parser.add_argument("--timeout-seconds", type=int, default=30, help="1 ページあたりの HTTP 上限秒数")
    parser.add_argument("--quiet", action="store_true", help="本文テキストを表示せず、保存パスだけ表示する")
    args = parser.parse_args()

    if not args.username or not args.password:
        # ここで秘密を表示してはいけないので、「どちらが空か」だけ教える
        print(f"◆ ユーザー名またはパスワードが未設定です（username={'設定済' if args.username else '空'}, "
              f"password={'設定済' if args.password else '空'}）。環境変数 CONFLUENCE_USERNAME / "
              "CONFLUENCE_PASSWORD を指定してください。", file=sys.stderr)
        return 1

    # 認証ヘッダー用の Base64（この値も表示しない）
    token = base64.b64encode(f"{args.username}:{args.password}".encode("utf-8")).decode("ascii")
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Windows のパイプでも日本語が化けないよう標準出力のエンコーディングを寄せる
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")  # type: ignore[attr-defined]
    except Exception:
        pass

    fetched: list[dict[str, Any]] = []
    missing: list[str] = []
    for page_id in args.page_id:
        status, body = fetch_page(args.base_url, page_id, token, args.expand, args.timeout_seconds)
        if status != 200:
            # 認証・権限・存在しないページは「失敗」ではなく検収待ち（exit 2）として集計する
            print(f"✖ pageId={page_id}: HTTP {status}（本文未取得）", file=sys.stderr)
            missing.append(page_id)
            continue
        raw_path = output_dir / f"page-{page_id}.json"
        raw_path.write_bytes(body)
        try:
            raw = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            print(f"✖ pageId={page_id}: JSON として解析できない（ログイン画面 HTML の可能性）", file=sys.stderr)
            missing.append(page_id)
            continue
        info = summarize(raw)
        text_path = output_dir / f"page-{page_id}.txt"
        text_path.write_text(info["bodyText"], encoding="utf-8")
        print(f"✔ pageId={page_id}: HTTP {status} / 「{info['title']}」 / space={info['spaceKey']} "
              f"/ version={info['version']} / 最終更新={info['versionWhen']} / 更新者={info['versionBy']}")
        print(f"  保存: {raw_path} ({len(body)} bytes), {text_path} ({len(info['bodyText'])} chars)")
        info["pageId"] = page_id
        fetched.append(info)

    # 監査用に、取得したページの一覧メタだけまとめた index を残す（本文は除く＝差分レビュー用）
    if fetched:
        index_path = output_dir / "index.json"
        index = [{k: v for k, v in item.items() if k != "bodyText"} for item in fetched]
        index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"✔ 取得一覧: {index_path} ({len(index)} 件)")

    if not args.quiet:
        for item in fetched:
            print("\n" + "=" * 78)
            print(f"◆ {item['pageId']} {item['title']}（version {item['version']} / {item['versionWhen']}）")
            print("=" * 78)
            print(item["bodyText"])

    if missing:
        print(f"◆ 未取得: {', '.join(missing)}", file=sys.stderr)
        return 2 if fetched else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
