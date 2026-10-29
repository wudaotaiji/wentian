"""分散CloudとAI最小内核を隔離検証する入口。

型検査と関連回帰試験を実行する。各試験は一時保存先、試験鍵、模擬AI、
ループバックの空きポートを使用し、実運用の設定・8787番・外部AIを使わない。
--outputは日本語ログと結果JSONの保存先。指定しない場合は一時フォルダーに保存する。
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    output = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix="wentian-federation-check-"))
    output.mkdir(parents=True, exist_ok=True)
    # 配列引数を使い、保存先や環境設定をシェルコードとして展開しない。
    commands = [
        ["node", "node_modules/typescript/bin/tsc", "--noEmit"],
        ["node", "--import", "tsx", "--import", "./src/test-environment.ts", "--test", "--test-concurrency=1",
         "src/cloud-federation.test.ts", "src/cloud-federation-ui.test.ts", "src/plugin-kernel.test.ts", "src/plugin-config.test.ts",
         "src/wentian-plugin-runtime.test.ts", "src/personal-cloud.test.ts", "src/server.test.ts", "src/agent-group.test.ts", "src/workbench.test.ts", "src/group-chat-ui.test.ts"],
    ]
    results = []
    for index, command in enumerate(commands):
        log = output / f"check-{index}.log"
        print(f"隔離検証を実行します：{index + 1}/{len(commands)}", flush=True)
        # テストの標準出力だけを記録し、環境変数や利用者の認証値を列挙しない。
        with log.open("w", encoding="utf-8") as stream:
            result = subprocess.run(command, cwd=root, env=dict(os.environ), stdout=stream,
                                    stderr=subprocess.STDOUT, encoding="utf-8", timeout=600)
        results.append({"command": command, "exitCode": result.returncode, "log": log.name})
        if result.returncode:
            break
    passed = len(results) == len(commands) and all(item["exitCode"] == 0 for item in results)
    (output / "result.json").write_text(json.dumps({"success": passed, "ai": "模擬AIのみ。実モデルの品質は未検証。",
                                                    "checks": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"検証結果：{'成功' if passed else '失敗'}。保存先：{output}")
    raise SystemExit(0 if passed else 1)


if __name__ == "__main__":
    main()
