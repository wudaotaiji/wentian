"""公開用ソースアーカイブを作り、秘密設定・実行時データ・Git履歴を除外します。

現在のGit管理対象と未登録ファイルを読み取り、除外ルールと接続先の検査を適用します。
検出結果に秘密値は出さず、ファイル名と行番号だけを記録します。公開は実行しません。
"""
from __future__ import annotations
import argparse
import hashlib
import ipaddress
import json
import re
import posixpath
import subprocess
import sys
import zipfile
import tempfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit, unquote

# 一般公開サービスの参照先です。新しい接続先は検収してから追加します。
PUBLIC_DOMAINS = set("a2a-protocol.org cline.bot duckduckgo.com frankfurter.dev github.com githubusercontent.com npmjs.org npmjs.com open-meteo.com kilo.ai cloudflare.com cloudflareaccess.com caddyserver.com stripe.com visualstudio.com coolify.io bitcoin.org openai.com langchain.com docker.com litellm.ai ollama.com openwebui.com pytorch.org ethereum.org ffmpeg.org googleapis.com huggingface.co jisaku.com chatgpt.com lmstudio.ai modelcontextprotocol.io nodejs.org opencode.ai openclaw.ai openrouter.ai playwright.dev squarespace.com pypi.org pypistats.org bing.com dify.ai figma.com w3.org contributor-covenant.org".split())
# Cloud・書房の設計文書で参照する公開プロジェクトと公的機関です。
PUBLIC_DOMAINS.update("k3s.io akash.network fsa.go.jp pbc.gov.cn karmada.io liqo.io kubernetes.io proxmox.com openstack.org ceph.com longhorn.io keycloak.org guacamole.apache.org learn.microsoft.com octask.ai jupyterlab.readthedocs.io jupyter-server.readthedocs.io".split())
# 製品比較で公式資料を確認した公開サイト。秘密設定の検出は従来どおり維持します。
PUBLIC_DOMAINS.update("n8n.io crewai.com microsoft.github.io ag2.ai openhands.dev manus.im".split())
# 会議機能の仕様で参照するWebRTCの公開技術資料です。
PUBLIC_DOMAINS.add("developer.mozilla.org")
# 容量整理で参照したuv公式資料です。PowerShell版もこの共通検査を使用します。
PUBLIC_DOMAINS.add("docs.astral.sh")
# 知識庫の公式参考資料とOffice XMLの標準名前空間を確認済みとして扱います。
# 接続設定の任意ホストを許可せず、実際に参照するホストだけを追加します。
PUBLIC_DOMAINS.update("mozilla.github.io schemas.openxmlformats.org ima.tencent.com apps.apple.com".split())
TEXT_SUFFIXES = {".ts", ".js", ".mjs", ".cjs", ".py", ".ps1", ".md", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".html", ".txt"}
PRIVATE_PARTS = {".git", ".wentian", ".agents", ".codex", ".aws", ".vscode", "node_modules", "dist", "output", "__pycache__", ".venv", ".e2e"}


def load_public_documents(root: Path) -> set[str]:
    """公開文書の完全一致リストを読み、不明な設定は公開せずに停止します。"""
    config = json.loads((root / "public_release_documents.json").read_text(encoding="utf-8"))
    if not isinstance(config, dict) or set(config) != {"version", "documents"} or type(config["version"]) is not int or config["version"] != 1 or not isinstance(config["documents"], list):
        raise RuntimeError("公開文書リストの形式が不正です。")
    documents = set()
    for value in config["documents"]:
        if not isinstance(value, str) or "\\" in value:
            raise RuntimeError("公開文書のパスが不正です。")
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or not value.startswith("docs/") or str(path) != value or value in documents or value.startswith("docs/evidence/"):
            raise RuntimeError("公開文書リストに重複または範囲外のパスがあります。")
        source = root / value
        if not source.is_file() or source.is_symlink() or not source.resolve().is_relative_to(root.resolve()):
            raise RuntimeError("公開文書が存在しないか範囲外です: " + value)
        documents.add(value)
    return documents


def publishable(relative: str, documents: set[str] | None = None) -> bool:
    """秘密設定と生成記録は、Git登録状態にかかわらず除外します。"""
    path = Path(relative)
    return not (any(part in PRIVATE_PARTS for part in path.parts)
        or relative.startswith("notebooks/")
        or relative.startswith("docs/evidence/")
        or (relative.startswith("docs/") and relative not in (documents or set()))
        or (path.name.startswith(".env") and path.name != ".env.example")
        or path.name.startswith((".codex-test", ".aider.chat", ".aider.input"))
        or path.suffix in {".log", ".pyc", ".bak", ".sqlite", ".sqlite3"}
        or path.name == "wentian-context.tar.gz"
        or any(part.startswith("archive-") for part in path.parts))


def public_host(host: str) -> bool:
    """例示ドメイン、ローカル接続、検収済み公開サービスを判定します。"""
    host = host.lower().rstrip(".")
    examples = {"example.com", "example.org", "example.net", "example.jp"}
    if host in {"localhost", "metadata.google.internal"} or "${" in host or host.endswith((".example", ".test", ".invalid", ".local", ".svc.cluster.local")) or host.startswith("example."):
        return True
    if any(host == domain or host.endswith("." + domain) for domain in PUBLIC_DOMAINS | examples):
        return True
    try:
        address = ipaddress.ip_address(host)
        return address.is_loopback or str(address) == "169.254.169.254"
    except ValueError:
        return "." not in host  # 単語だけのテスト入力を除きます。


def findings(relative: str, raw: bytes) -> list[dict]:
    """秘密値を表示せず、未確認のURLとメール、秘密鍵形式を検出します。"""
    path = Path(relative)
    if path.suffix not in TEXT_SUFFIXES and path.name not in {"Dockerfile", "Dockerfile.fix", "Dockerfile.workflow-mcp", ".env.example"}:
        return []
    if path.name in {"package-lock.json", "tokenizer.json"}:
        return []  # ハッシュと語彙は接続先設定ではありません。
    result = []
    for number, line in enumerate(raw.decode("utf-8-sig").splitlines(), 1):
        categories = set()
        if re.search(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b", line):
            categories.add("秘密鍵またはアクセスキー")
        # 公開トークンの書式と接続文字列を検査し、一致した値自体は記録しません。
        if re.search(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b|\bxox[baprs]-[A-Za-z0-9-]{24,}\b", line):
            categories.add("認証トークンの可能性")
        for match in re.finditer(r"https?://[^\s<>\"'`,)]+", line):
            try:
                parsed = urlsplit(match.group())
                host = parsed.hostname
                reserved = {"example.com", "example.org", "example.net", "example.jp"}
                fixture = bool(host and (host.endswith((".test", ".example", ".invalid")) or any(host == domain or host.endswith("." + domain) for domain in reserved)))
                if (parsed.username or parsed.password) and not fixture:
                    categories.add("資格情報付き接続先の可能性")
                if host and not public_host(host):
                    categories.add("未確認の接続先")
            except ValueError:
                categories.add("解析できない接続先")
        for match in re.finditer(r"[\w.+%-]+@([\w.-]+\.[A-Za-z]{2,})", line):
            if not public_host(match.group(1)):
                categories.add("実アカウントの可能性")
        result.extend({"file": relative, "line": number, "category": category} for category in sorted(categories))
    return result


def document_link_findings(files: dict[str, bytes]) -> list[dict]:
    """配布するMarkdownから、非配布文書や範囲外への相対リンクを検出します。"""
    result = []
    for relative, raw in files.items():
        if not relative.lower().endswith(".md"):
            continue
        fenced = False
        for number, line in enumerate(raw.decode("utf-8-sig").splitlines(), 1):
            if line.lstrip().startswith(("```", "~~~")):
                fenced = not fenced
                continue
            if fenced:
                continue
            line = re.sub(r"`[^`]+`", "", line)
            for match in re.finditer(r"!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)", line):
                url = match.group(1).strip("<>")
                parsed = urlsplit(url)
                if parsed.scheme or not parsed.path or parsed.path.startswith("/"):
                    continue
                target = posixpath.normpath(posixpath.join(posixpath.dirname(relative), unquote(parsed.path)))
                if target not in files and not any(name.startswith(target.rstrip("/") + "/") for name in files):
                    result.append({"file": relative, "line": number, "category": "配布範囲外または存在しない資料へのリンク"})
    return result


def main() -> None:
    """現在の内容を検査し、合格した場合だけ公開候補を書き出します。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit-only", action="store_true", help="検査だけを実行します。")
    parser.add_argument("--self-test", action="store_true", help="除外と検出ルールの回帰試験を実行します。")
    arguments = parser.parse_args()
    if arguments.self_test:
        # 新規文書・添付資料は既定で非公開。既知の公開文書だけを許可します。
        fixture_documents = {"docs/guide.md"}
        if not publishable("docs/guide.md", fixture_documents) or publishable("docs/new_design.md", fixture_documents) or publishable("docs/new_image.png", fixture_documents) or publishable("docs/guide.md"):
            raise RuntimeError("公開文書の許可リスト試験に失敗しました。")
        if not document_link_findings({"README.md": b"[private](docs/private.md)"}) or document_link_findings({"README.md": b"[guide](docs/guide.md)", "docs/guide.md": b"# guide"}):
            raise RuntimeError("非配布文書へのリンク検出試験に失敗しました。")
        # 設定検証も一時領域だけで行い、実際の許可リストは変更しません。
        with tempfile.TemporaryDirectory(prefix="wentian-public-docs-") as folder:
            fixture_root = Path(folder)
            (fixture_root / "docs").mkdir()
            (fixture_root / "docs/guide.md").write_text("# guide", encoding="utf-8")
            config_path = fixture_root / "public_release_documents.json"
            config_path.write_text(json.dumps({"version": 1, "documents": ["docs/guide.md"]}), encoding="utf-8")
            if load_public_documents(fixture_root) != fixture_documents:
                raise RuntimeError("許可リストの読取り試験に失敗しました。")
            for invalid in (["docs/../secret.md"], ["docs/guide.md", "docs/guide.md"], ["docs/missing.md"], ["docs/evidence/private.md"]):
                config_path.write_text(json.dumps({"version": 1, "documents": invalid}), encoding="utf-8")
                try:
                    load_public_documents(fixture_root)
                except RuntimeError:
                    pass
                else:
                    raise RuntimeError("不正な公開文書設定を受け入れました。")
        # 一時データだけを検査し、作業ツリーや秘密設定は参照しません。
        for private in (".env", ".env.production", ".wentian/auth.json", ".git/config", "docs/evidence/private.png", "notebooks/report.md", "local.sqlite", ".aws/credentials"):
            if publishable(private):
                raise RuntimeError("非公開ファイルの除外試験に失敗しました。")
        for public in (".env.example", "README.md", "src/config.ts", "LICENSE"):
            if not publishable(public):
                raise RuntimeError("公開ファイルの選別試験に失敗しました。")
        unknown = ("https://" + "wiki." + "customer-domain.com" + " staff" + "@" + "customer-domain.com").encode()
        if findings("sample.md", unknown) == []:
            raise RuntimeError("企業接続先の検出試験に失敗しました。")
        if findings("sample.md", b"https://wiki.example.com member@example.com http://127.0.0.1:1234/v1"):
            raise RuntimeError("例示値の検査試験に失敗しました。")
        if findings("sample.md", b"https://mozilla.github.io/pdf.js/examples/ http://schemas.openxmlformats.org/drawingml/2006/chart https://ima.tencent.com/download https://apps.apple.com/cn/app/id6737188438 https://docs.astral.sh/uv/concepts/cache/"):
            raise RuntimeError("確認済みの公式参考資料の検査試験に失敗しました。")
        # 実鍵を埋め込まず、検出対象のマーカーを試験時に組み立てます。
        if not findings("sample.txt", ("-----BEGIN " + "PRIVATE KEY-----").encode()):
            raise RuntimeError("秘密鍵の検出試験に失敗しました。")
        print("公開検査の回帰試験が成功しました。")
        return
    root = Path(__file__).resolve().parents[1]
    documents = load_public_documents(root)
    listed = subprocess.check_output(["git", "-c", "safe.directory=" + root.as_posix(), "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root)
    files, problems = {}, []
    for relative in sorted(set(listed.decode("utf-8").split("\0")) - {""}):
        if not publishable(relative, documents):
            continue
        source = root / relative
        if not source.exists():
            continue  # 作業ツリーで削除済みのファイルを公開しません。
        if source.is_symlink() or not source.resolve().is_relative_to(root):
            raise RuntimeError("公開範囲外を指すファイルを拒否しました: " + relative)
        raw = source.read_bytes()
        files[relative] = raw
        problems.extend(findings(relative, raw))
    links = document_link_findings(files)
    problems.extend(links)
    report = {"files": len(files), "findings": problems, "gitHistoryIncluded": False, "publicDocuments": sorted(relative for relative in files if relative.startswith("docs/")), "excludedDocuments": sorted(relative for relative in set(listed.decode("utf-8").split("\0")) if relative.startswith("docs/") and relative not in files), "fileManifest": [{"file": relative, "sha256": hashlib.sha256(raw).hexdigest()} for relative, raw in files.items()]}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if problems:
        destination = root / ".wentian" / "public-release"
        destination.mkdir(parents=True, exist_ok=True)
        (destination / "audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        raise SystemExit("公開検査で確認が必要な記載を検出しました。")
    if arguments.audit_only:
        destination = root / ".wentian" / "public-release"
        destination.mkdir(parents=True, exist_ok=True)
        (destination / "audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return
    destination = root / ".wentian" / "public-release"
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / "wentian-source.zip"
    temporary = destination / "wentian-source.tmp.zip"
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as output:
        for relative, raw in files.items():
            output.writestr("wentian/" + relative, raw)
    # 全ファイルを読み直して、欠損・混入・内容の不一致を確認します。
    with zipfile.ZipFile(temporary) as checked:
        if set(checked.namelist()) != {"wentian/" + item for item in files} or checked.testzip():
            raise RuntimeError("公開アーカイブの内容検査に失敗しました。")
        for relative, raw in files.items():
            if checked.read("wentian/" + relative) != raw:
                raise RuntimeError("公開内容が一致しません: " + relative)
    temporary.replace(archive)
    report.update(archive=str(archive), sha256=hashlib.sha256(archive.read_bytes()).hexdigest())
    (destination / "manifest.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"archive": str(archive), "sha256": report["sha256"]}, ensure_ascii=False))


if __name__ == "__main__":
    # Windowsの既定文字コードに左右されず、日本語の検査ログを出力します。
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
