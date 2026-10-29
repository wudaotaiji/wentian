# 既存設定のモデル識別子だけを読み取るPython処理を呼び出します。
# 認証情報・URLを表示せず、設定・会話・実行中Agentを変更しません。
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Agent,[string]$AgentHome=[Environment]::GetFolderPath('UserProfile'))
$ErrorActionPreference='Stop'
$env:PYTHONIOENCODING='utf-8'
$projectPython=Join-Path $PSScriptRoot '..\.venv\Scripts\python.exe'
$arguments=@((Join-Path $PSScriptRoot 'list-agent-models.py'),'--agent',$Agent,'--home',$AgentHome)
# 明示されたPythonを優先し、仮想環境がなければWindowsランチャーへ渡します。
if($env:WENTIAN_MAINTENANCE_PYTHON){
    if([IO.Path]::GetFileNameWithoutExtension($env:WENTIAN_MAINTENANCE_PYTHON) -eq 'py'){& $env:WENTIAN_MAINTENANCE_PYTHON -3 @arguments}
    else{& $env:WENTIAN_MAINTENANCE_PYTHON @arguments}
}elseif(Test-Path -LiteralPath $projectPython){& $projectPython @arguments}
else{& py -3 @arguments}
exit $LASTEXITCODE
