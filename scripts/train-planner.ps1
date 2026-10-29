# Wentian分類学習エンジンのPowerShell入口。
# 学習・評価・推論の実処理は同梱Python版へ委譲し、引数を配列のまま渡します。
# モデル取得は -AllowDownload の明示指定時だけ許可します。
param(
    [ValidateSet('train','infer')][string]$Operation = 'train',
    [Parameter(Mandatory)][string]$Directory,
    [ValidateRange(1,2000)][int]$Steps = 100,
    [ValidateSet('auto','cpu','cuda')][string]$Device = 'auto',
    [switch]$AllowDownload,
    [string]$Python = '',
    [ValidateSet('Qwen/Qwen2.5-0.5B-Instruct','Qwen/Qwen2.5-1.5B-Instruct','Qwen/Qwen2.5-3B-Instruct')][string]$BaseModel = 'Qwen/Qwen2.5-0.5B-Instruct',
    [string]$Revision = '',
    [double]$LearningRate = 0.0002,
    [ValidateSet(8,16,32)][int]$LoraRank = 8,
    [switch]$AllLinear,
    [ValidateSet(1,2,4,8)][int]$EvaluationBatchSize = 1,
    [string]$ResumeAdapter = ''
)
$ErrorActionPreference = 'Stop'
# インストール先の専用環境を既定にし、利用者の他プロジェクトのPythonを変更しません。
if (-not $Python) { $Python = Join-Path $PSScriptRoot '..\.wentian\planner-engine\Scripts\python.exe' }
$engineArgs = @((Join-Path $PSScriptRoot 'train-planner.py'), $Operation, '--directory', $Directory, '--steps', "$Steps", '--device', $Device)
if ($AllowDownload) { $engineArgs += '--allow-download' }
# 比較学習の条件を明示してPythonへ渡し、保存された版と推論時のモデルを一致させます。
$engineArgs += @('--base-model',$BaseModel,'--learning-rate',$LearningRate.ToString([System.Globalization.CultureInfo]::InvariantCulture),'--lora-rank',"$LoraRank",'--evaluation-batch-size',"$EvaluationBatchSize")
if ($Revision) { $engineArgs += @('--revision',$Revision) }
if ($AllLinear) { $engineArgs += '--all-linear' }
# 補習時だけ既存重みを指定し、親重みのハッシュをPython側で保存します。
if ($ResumeAdapter) { $engineArgs += @('--resume-adapter',$ResumeAdapter) }
$env:PYTHONUTF8 = '1'
# 推論時は標準入力からJSONを渡し、終了コードを呼び出し元へそのまま返します。
if ($Operation -eq 'infer') {
    # PowerShellのパイプ入力は自動では子プロセスへ渡らないため、明示的にJSONを転送します。
    $plannerInput = @($input) -join "`n"
    if (-not $plannerInput) { throw '推論用のJSONをパイプで標準入力へ渡してください。' }
    $plannerInput | & $Python @engineArgs
} else {
    & $Python @engineArgs
}
exit $LASTEXITCODE
