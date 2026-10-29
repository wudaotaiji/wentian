# Mail Solutions 学習エンジンの PowerShell 入口です。
# 分類・抽出アルゴリズムは同梱の Python 版で一元管理し、二重実装による結果の差を防ぎます。
# 実行フォルダーは API が作成した版固定データとモデル成果物を格納する場所です。
param(
    [ValidateSet('train', 'infer')][string]$Operation = 'train',
    [Parameter(Mandatory)][ValidateSet('classification', 'extraction')][string]$Task,
    [Parameter(Mandatory)][string]$Directory,
    [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'

# 存在しない実行フォルダーや未確認の学習データを暗黙に作らないようにします。
$resolvedDirectory = (Resolve-Path -LiteralPath $Directory -ErrorAction Stop).Path
$engine = Join-Path $PSScriptRoot 'train-mail.py'
if (-not (Test-Path -LiteralPath $engine -PathType Leaf)) {
    throw 'Mail Solutions の Python 学習エンジンが見つかりません。'
}

# Windows の Python でも日本語メールの入出力を UTF-8 に固定します。
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
$arguments = @($engine, $Operation, '--task', $Task, '--directory', $resolvedDirectory)
if ($Operation -eq 'infer') {
    # 予測対象の JSON はパイプ経由で渡し、コマンド引数やログに本文を残しません。
    $mailJson = @($input) -join "`n"
    if (-not $mailJson) { throw '予測対象の JSON を標準入力へ渡してください。' }
    $mailJson | & $Python @arguments
} else {
    & $Python @arguments
}
exit $LASTEXITCODE
