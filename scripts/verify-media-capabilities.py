"""制作能力の会話連携（Capability Context）を検証します。

既定は型検査と関連試験のみです。--liveは接続済みの実LLMへ元の質問を送り、
制作機能・画面・小型動画モデルの制限を説明できることを確認します。
生成・モデル取得・サービス再起動は行いません。秘密値はログへ出しません。
"""
import argparse
import os
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    evidence = root / "docs/evidence/media-capabilities/20261007"
    evidence.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ, PYTHONIOENCODING="utf-8", WENTIAN_RESPONSE_LANGUAGE="ja")
    commands = [("build.log", ["node", "node_modules/typescript/bin/tsc", "--noEmit"]), ("checks.log", ["node", "--import", "tsx", "--import", "./src/test-environment.ts", "--test", "src/media-agent-capabilities.test.ts", "src/chat-agent.test.ts", "src/agent-tools.test.ts", "src/cli-inquiry.test.ts"])]
    if args.live:
        commands.append(("live-cli.log", ["node", "bin/wentian.js", "agent", "--execution-mode", "direct", "--timeout-ms", "90000", "--", "听说你有制作视频音频的能力了？"]))
    for filename, command in commands:
        with (evidence / filename).open("w", encoding="utf-8") as log:
            result = subprocess.run(command, cwd=root, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=180)
        if result.returncode:
            raise RuntimeError("会話能力の検証が失敗しました。" + filename + "を確認してください。")
    if args.live:
        result = (evidence / "live-cli.log").read_text(encoding="utf-8")
        assert "/media-studio" in result
        assert "検証" in result or "ランダム" in result
        assert "動画や音声を直接制作する能力は持っていません" not in result
    print("制作能力の会話連携を検証しました。実LLMの確認範囲は--liveの有無で区別します。")


if __name__ == "__main__":
    main()
