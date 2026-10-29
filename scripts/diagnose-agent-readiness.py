"""稼働GatewayのAgent状態を読取り専用で収集します。秘密設定や依頼本文は保存しません。"""
import argparse
import json
import sys
from pathlib import Path
from urllib.request import urlopen

# Windowsの既定文字コードに依存せず、日本語の診断ログをUTF-8で出力します。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# 接続先と保存先を利用者が明示し、特定組織の環境へ暗黙接続しません。
parser = argparse.ArgumentParser(description="Agentの利用可否と保留理由を取得します。")
parser.add_argument("--server", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
# refresh=trueやPOSTを使わず、表示用APIのGETだけを呼びます。
with urlopen(args.server.rstrip("/") + "/v1/manager/external-agents", timeout=30) as response:
    data = json.load(response)
# 接続の秘密値、試験本文、起動引数は証跡に含めません。
result = {"summary": data.get("summary"), "refreshedAt": data.get("refreshedAt"),
          "pools": data.get("pools"), "agents": []}
for agent in data.get("agents", []):
    connection = agent.get("connection") or {}
    work = agent.get("workEvidence") or {}
    result["agents"].append({"id": agent["id"], "state": agent.get("state"),
        "stateLabel": agent.get("stateLabel"), "liveState": agent.get("liveState"),
        "excluded": agent.get("excluded"), "connectionStatus": connection.get("status"),
        # 一時停止と権限取消を分け、期限更新が不要な既定の保守権限も確認します。
        "executionAccess": agent.get("executionAccess"),
        "deferredKind": connection.get("maintenanceDeferredKind"),
        "reason": connection.get("reason"), "workStatus": work.get("status"),
        "workExpiresAt": work.get("expiresAt")})
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("Agent診断の証跡を保存しました: " + str(output))
