# 動画・音声の実ワーカーを、本番と同じ設定で隔離検証するPowerShell入口です。
# 既存LLMや利用者の素材を停止・変更せず、証拠を専用フォルダーへ保存します。
$ErrorActionPreference='Stop'
$env:PYTHONUTF8='1'
$env:PYTHONIOENCODING='utf-8'
$Project=Split-Path -Parent $PSScriptRoot
& (Join-Path $Project '.wentian/planner-engine/Scripts/python.exe') (Join-Path $PSScriptRoot 'verify-video-runtime.py')
exit $LASTEXITCODE
