# Wentianの既存基底モデル（Base Model）を使うPython推論を起動します。
# JSON（ジェイソン / JSON）入力を標準入力から受け取り、本文を保存しません。
param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $taskRoot '.wentian/planner-engine/Scripts/python.exe'
# モデルとライブラリの版を既存学習環境とそろえて実行します。
& $pythonPath (Join-Path $PSScriptRoot 'propose-mail-categories.py') --directory $Directory
if ($LASTEXITCODE -ne 0) { throw '基底モデルの分類提案に失敗しました。' }
