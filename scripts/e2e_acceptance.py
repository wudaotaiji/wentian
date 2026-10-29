"""Wentian Gatewayの安全なE2E受入試験。

標準ライブラリだけを使用し、状態変更APIを呼びません。Gatewayは事前に起動してください。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import urllib.request

BASE_URL = "http://127.0.0.1:8787"


def request_json(path: str, payload: dict | None = None, timeout: int = 120) -> dict:
    """HTTP要求を送り、JSON応答を辞書へ変換します。"""
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload else None
    headers = {"Content-Type": "application/json"} if payload else {}
    request = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method="POST" if payload else "GET")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def chat(model: str) -> dict:
    """指定した仮想モデルで最小チャット要求を実行します。"""
    return request_json("/v1/chat/completions", {
        "model": model,
        "messages": [{"role": "user", "content": "OKとのみ回答してください"}],
        "max_tokens": 64,
        "stream": False,
    })


def run_client(command: list[str], timeout: int = 120) -> None:
    """外部CLIを制限時間付きで実行し、失敗を明示します。"""
    # WindowsのCLIはnpmが生成した.cmdであるため、shutil.whichで完全パスへ解決します。
    executable = shutil.which(command[0])
    if executable is None:
        raise RuntimeError(f"CLIがPATHに見つかりません: {command[0]}")
    completed = subprocess.run([executable, *command[1:]], check=False, timeout=timeout)
    if completed.returncode != 0:
        raise RuntimeError(f"CLIが失敗しました: {command[0]}、終了コード={completed.returncode}")


def test_sse_disconnect() -> None:
    """最初のSSEデータを受信して切断し、その後もGatewayが生存することを確認します。"""
    payload = json.dumps({
        "model": "wentian-auto/remote",
        "messages": [{"role": "user", "content": "短く説明してください"}],
        "max_tokens": 128,
        "stream": True,
    }, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        BASE_URL + "/v1/chat/completions",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    # withブロックを最初のdata行で抜けることで、クライアント途中切断を安全に再現します。
    with urllib.request.urlopen(request, timeout=120) as response:
        first_line = response.readline().decode("utf-8", errors="replace")
        if not first_line.startswith("data:"):
            raise RuntimeError("SSEのdata行を受信できませんでした。")
    if not request_json("/health", timeout=10).get("ok"):
        raise RuntimeError("SSE切断後にGatewayが停止しました。")


def test_mcp_endpoint() -> None:
    """MCPのinitializeとTool一覧を実Gatewayへ送り、Streamable HTTP入口を検証します。"""
    initialized = request_json("/mcp", {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "wentian-e2e-python", "version": "1.0"},
        },
    }, timeout=10)
    if initialized.get("result", {}).get("serverInfo", {}).get("name") != "wentian-gateway":
        raise RuntimeError("MCP initialize応答が不正です。")
    listed = request_json("/mcp", {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, timeout=10)
    if not listed.get("result", {}).get("tools"):
        raise RuntimeError("MCP Tool一覧を取得できませんでした。")


def main() -> int:
    """Health、外部、ローカル、両クライアントを順に検証します。"""
    # Windowsコンソールでも日本語の診断メッセージが文字化けしないようUTF-8へ統一します。
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    health = request_json("/health", timeout=10)
    if not health.get("ok"):
        raise RuntimeError("Gateway Healthが正常ではありません。")
    print("Health: OK")
    print("Remote:", json.dumps(chat("wentian-auto/remote").get("wentian"), ensure_ascii=False))
    print("Local:", json.dumps(chat("wentian-auto/local").get("wentian"), ensure_ascii=False))
    test_sse_disconnect()
    print("SSE disconnect: OK")
    run_client(["opencode", "run", "--model", "wentian/wentian-auto/remote", "OKとのみ回答してください"])
    run_client(["kilo", "run", "--model", "wentian/wentian-auto/remote", "OKとのみ回答してください"])
    test_mcp_endpoint()
    print("MCP Streamable HTTP: OK")
    print("E2E受入試験が完了しました。")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, TimeoutError, subprocess.TimeoutExpired) as error:
        print(f"E2E受入試験に失敗しました: {error}", file=sys.stderr)
        raise SystemExit(1)
