<#
.SYNOPSIS
WentianのMiniMax H3動画ワーカーを手動で診断または実行します。
.DESCRIPTION
本スクリプトはPythonワーカーの薄い起動ラッパーです。モデルの取得・削除・更新は行わず、
既存のComfyUI共有モデルだけを読み込みます。診断時は必要に応じてComfyUIを起動します。
標準出力のJSON進捗はWentianの動画キューと同じ形式です。
.PARAMETER Diagnose
モデル一式とComfyUI APIを確認します。
.PARAMETER JobPath
Wentianが作成したrequest.jsonを含む動画ジョブ専用フォルダーを指定します。
.PARAMETER PythonPath
Python実行ファイルを明示する場合に指定します。省略時はPATH上のpythonを使います。
#>
param(
    [switch]$Diagnose,
    [string]$JobPath,
    [string]$PythonPath = "python"
)

# 常にこのスクリプトと同じscriptsフォルダーのPython実装を呼び、
# カレントディレクトリによって別のスクリプトを起動しないようにします。
$ErrorActionPreference = "Stop"
$workerPath = Join-Path $PSScriptRoot "comfyui-h3-video-worker.py"
if (-not (Test-Path -LiteralPath $workerPath -PathType Leaf)) {
    throw "MiniMax H3ワーカーが見つかりません。Wentianのscriptsフォルダーを確認してください。"
}

# 診断と生成を同時指定すると意図しないジョブを開始するため、引数を一方に限定します。
if ($Diagnose -and $JobPath) {
    throw "-Diagnoseと-JobPathは同時に指定できません。"
}
if (-not $Diagnose -and -not $JobPath) {
    throw "-Diagnoseまたは-Wentianのジョブフォルダーを指定する-JobPathが必要です。"
}

# Python引数は配列で渡し、パスに空白が含まれても一つの引数として扱います。
$workerArguments = @($workerPath)
if ($Diagnose) {
    $workerArguments += "--diagnose"
} else {
    $resolvedJobPath = (Resolve-Path -LiteralPath $JobPath -ErrorAction Stop).Path
    $workerArguments += @("--job", $resolvedJobPath)
}
& $PythonPath @workerArguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
