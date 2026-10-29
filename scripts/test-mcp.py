"""MCPの初期化・ツール一覧・終了を標準ライブラリーで確認します。

読み取り専用の診断です。タスク登録・外部ツール実行は行いません。
URLは第1引数、認証はWENTIAN_MCP_API_KEYまたはWENTIAN_API_KEYで指定します。
"""
import json
import os
import sys
import urllib.request

# Windowsの既定コードページに左右されず、パイプ先へも日本語をUTF-8で出力します。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

endpoint = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787").rstrip("/") + "/mcp"
headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
key = os.getenv("WENTIAN_MCP_API_KEY") or os.getenv("WENTIAN_API_KEY")
if key:
    headers["Authorization"] = f"Bearer {key}"

def send(message):
    """JSON-RPC要求を送り、応答ヘッダーと本文を取得します。"""
    request = urllib.request.Request(endpoint, data=json.dumps(message).encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:
        content = response.read()
        return response.headers, json.loads(content) if content else None

try:
    response_headers, info = send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "wentian-check", "version": "1.0"}}})
    if "error" in info:
        raise SystemExit("MCP初期化に失敗しました。")
    headers["Mcp-Session-Id"] = response_headers["Mcp-Session-Id"]
    headers["Mcp-Protocol-Version"] = info["result"]["protocolVersion"]
    send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    _, result = send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    print(json.dumps(result, ensure_ascii=False, indent=2))
finally:
    # 異常時もセッションを終了し、接続を残しません。
    if headers.get("Mcp-Session-Id"):
        # DELETEは本文を持たないため、JSON本文の解析を要求するヘッダーを外します。
        delete_headers = {name: value for name, value in headers.items() if name.lower() != "content-type"}
        with urllib.request.urlopen(urllib.request.Request(endpoint, headers=delete_headers, method="DELETE"), timeout=10):
            pass
