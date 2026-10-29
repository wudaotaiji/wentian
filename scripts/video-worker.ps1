<#
動画ワーカー（Video Worker）のPowerShell入口です。
推論処理は同じディレクトリーのPython版に集約し、両入口で同じ生成方式を使います。
既定の専用Python環境を使用し、設定時だけWENTIAN_VIDEO_PYTHONを優先します。
ジョブの保存先を引数配列として渡し、プロンプトをコマンドラインへ出しません。
#>
[CmdletBinding(DefaultParameterSetName='Diagnose')]
param([Parameter(ParameterSetName='Diagnose')][switch]$Diagnose,
      [Parameter(Mandatory,ParameterSetName='Job')][string]$Job)
$ErrorActionPreference = 'Stop'
$videoPython = $env:WENTIAN_VIDEO_PYTHON
if (-not $videoPython) { $videoPython = Join-Path (Split-Path $PSScriptRoot -Parent) '.wentian/video-engine/Scripts/python.exe' }
$workerArguments = @('--diagnose')
if ($PSCmdlet.ParameterSetName -eq 'Job') { $workerArguments = @('--job',$Job) }
$env:PYTHONIOENCODING = 'utf-8'
& $videoPython (Join-Path $PSScriptRoot 'video-worker.py') @workerArguments
exit $LASTEXITCODE
