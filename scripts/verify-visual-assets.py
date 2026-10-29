"""背景と人物制作を、一時領域へ隔離した試験で検証します。

本番データ・実サービスへ制作依頼は送りません。失敗したコマンドの
終了コードを返し、呼出し元が検証失敗を検出できるようにします。
"""
from pathlib import Path
import subprocess
import os

root = Path(__file__).resolve().parent.parent
commands = [
    ["npm.cmd" if os.name == "nt" else "npm", "run", "build"],
    ["node", "--import", "tsx", "--import", "./src/test-environment.ts", "--test",
     "src/group-selection-ui.test.ts", "src/forge-scene.test.ts", "src/public-site.test.ts", "src/visual-assets.test.ts", "src/wentian-image-runtime.test.ts", "src/codex-image.test.ts", "src/external-agent-readiness.test.ts", "src/startup-forge-room.test.ts",
     "src/startup-forge-social-ui.test.ts", "src/startup-forge-motion-ui.test.ts", "src/group-human.test.ts", "src/group-chat-ui.test.ts", "src/group-management.test.ts",
     "src/group-agent-responder.test.ts", "src/agent-web-search.test.ts"],
]
for command in commands:
    print("検証を実行: " + " ".join(command), flush=True)
    result = subprocess.run(command, cwd=root, check=False)
    if result.returncode:
        raise SystemExit(result.returncode)
print("背景と人物制作の検証が完了しました。")
