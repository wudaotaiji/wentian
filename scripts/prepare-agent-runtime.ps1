# エージェント専用Node.js LTSを、PC全体の環境を変更せず準備します。
# Python版と同じ取得・チェックサム照合・パス検査を使うため、処理を共通化します。
param([string]$Root = (Join-Path $PSScriptRoot '../.wentian/agent-runtime'))
$ErrorActionPreference = 'Stop'
# 引数は文字列コマンドへ連結せず配列として渡し、空白を含む保存先も保護します。
$PythonArguments = @((Join-Path $PSScriptRoot 'prepare-agent-runtime.py'), '--root', $Root)
python @PythonArguments
if ($LASTEXITCODE -ne 0) { throw 'エージェント専用ランタイムの準備に失敗しました。' }
