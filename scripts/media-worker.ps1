<#
音声・動画制作ワーカー（Media Worker）のPowerShell入口です。
推論・編集の実装はPython版へ集約し、同じジョブ台帳と出力形式を使用します。
制作本文を引数に含めず、Wentianが作成したrequest.jsonを読み込みます。
既定の動画用Python環境を再利用し、ComfyUIは起動・参照しません。
#>
[CmdletBinding(DefaultParameterSetName='Diagnose')]
param([Parameter(ParameterSetName='Diagnose')][switch]$Diagnose,
      [Parameter(Mandatory,ParameterSetName='Job')][string]$Job)
$ErrorActionPreference = 'Stop'
$mediaPython = $env:WENTIAN_VIDEO_PYTHON
if (-not $mediaPython) { $mediaPython = Join-Path (Split-Path $PSScriptRoot -Parent) '.wentian/video-engine/Scripts/python.exe' }
$mediaArguments = @('--diagnose')
if ($PSCmdlet.ParameterSetName -eq 'Job') { $mediaArguments = @('--job',$Job) }
$env:PYTHONIOENCODING = 'utf-8'
& $mediaPython (Join-Path $PSScriptRoot 'media-worker.py') @mediaArguments
exit $LASTEXITCODE
