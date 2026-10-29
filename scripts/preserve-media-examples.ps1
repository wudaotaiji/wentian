<#
.SYNOPSIS
検証で作った文章・動画・音声をサンプル（Examples）として保存します。
.DESCRIPTION
Python版と同じ既知の成果物だけをexamples/mediaへコピーします。
実作品や認証情報を読みません。本文・モデルの性質を説明した一覧も保存します。
#>
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
& python (Join-Path $PSScriptRoot 'preserve-media-examples.py')
exit $LASTEXITCODE
