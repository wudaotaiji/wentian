# Wentian Gateway Windows installer.
#
# This script is designed for the following one-line installation command:
#   irm https://raw.githubusercontent.com/wudaotaiji/wentian/main/install.ps1 | iex
#
# The installer downloads the main branch into a temporary directory, installs
# the locked npm dependencies, then publishes a small `wentian.cmd` launcher in
# a user-owned directory. Existing `.env` settings are carried over on update.
[CmdletBinding()]
param(
    [string]$SourceDirectory,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\wentian-gateway'),
    [switch]$NoPathUpdate
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepositoryArchive = 'https://github.com/wudaotaiji/wentian/archive/refs/heads/main.zip'
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$LauncherDirectory = Join-Path $env:LOCALAPPDATA 'Programs\wentian-gateway-bin'
$TemporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('wentian-install-' + [guid]::NewGuid().ToString('N'))
$ArchivePath = Join-Path $TemporaryRoot 'wentian-gateway.zip'
$ExtractRoot = Join-Path $TemporaryRoot 'extract'
$StagingRoot = Join-Path $TemporaryRoot 'staging'
$BackupRoot = "$InstallRoot.backup"
if ($NoPathUpdate) { $LauncherDirectory = "$InstallRoot-bin" }

function Write-Step([string]$Message) {
    Write-Host "[Wentian] $Message" -ForegroundColor Cyan
}

function Add-UserPath([string]$Directory) {
    # Process PATH is updated immediately; the persistent user PATH applies to
    # terminals opened after installation.
    $currentUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @($currentUserPath -split ';' | Where-Object { $_ })
    if ($entries -notcontains $Directory) {
        [Environment]::SetEnvironmentVariable('Path', (($entries + $Directory) -join ';'), 'User')
    }
    if (($env:Path -split ';') -notcontains $Directory) {
        $env:Path = "$Directory;$env:Path"
    }
}

if (-not $env:LOCALAPPDATA) {
    throw 'LOCALAPPDATAを確認できません。Windowsのユーザーセッションで実行してください。'
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
    throw 'Node.jsとnpmが必要です。Node.js 20以降をインストールしてから、もう一度実行してください: winget install OpenJS.NodeJS.LTS'
}

$nodeMajor = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) {
    throw "Node.js 20以降が必要です。現在のバージョン: $(& $node.Source --version)"
}

$installed = $false
New-Item -ItemType Directory -Path $TemporaryRoot, $ExtractRoot -Force | Out-Null
try {
    # ローカル導入では秘密設定、Git履歴、実行時データを複製しません。
    if ($SourceDirectory) {
        $sourcePath = (Resolve-Path -LiteralPath $SourceDirectory).Path
        & git -C $sourcePath archive --format=zip --output=$ArchivePath HEAD
        if ($LASTEXITCODE -ne 0) { throw 'ローカルGitソースの取得に失敗しました。' }
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $StagingRoot -Force
        # 作業中の追跡済み修正も反映し、未追跡の秘密ファイルは除外します。
        & git -C $sourcePath ls-files | ForEach-Object {
            $target = Join-Path $StagingRoot $_
            if (Test-Path -LiteralPath (Join-Path $sourcePath $_) -PathType Leaf) {
                New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
                Copy-Item -LiteralPath (Join-Path $sourcePath $_) -Destination $target -Force
            }
        }
    } else {
        Write-Step "ソースを取得しています: $RepositoryArchive"
        try {
            Invoke-WebRequest -Uri $RepositoryArchive -OutFile $ArchivePath -UseBasicParsing -TimeoutSec 120
        } catch {
            throw "ソースを取得できません: $RepositoryArchive 。公開状態・URL・接続を確認してください。Git取得済みの場合は -SourceDirectory を指定できます。原因: $($_.Exception.Message)"
        }
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractRoot -Force
        $sourceRoot = Get-ChildItem -LiteralPath $ExtractRoot -Directory | Select-Object -First 1
        if (-not $sourceRoot) { throw 'アーカイブにソースがありません。' }
        Move-Item -LiteralPath $sourceRoot.FullName -Destination $StagingRoot
    }
    foreach ($required in @('package-lock.json', 'wentian.plugins.json', 'bin\wentian.js')) {
        if (-not (Test-Path -LiteralPath (Join-Path $StagingRoot $required))) { throw "必須ファイルがありません: $required" }
    }
    Write-Step '固定されたnpm依存関係をインストールしています。'
    & $npm.Source ci --prefix $StagingRoot --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ciが終了コード $LASTEXITCODE で失敗しました。" }

    Write-Step 'TypeScriptの型検査を実行しています。'
    & $npm.Source run build --prefix $StagingRoot
    if ($LASTEXITCODE -ne 0) { throw "npm run buildが終了コード $LASTEXITCODE で失敗しました。" }

    # 配置前に別ディレクトリーから実CLIを起動し、Manifest解決も検証します。
    Push-Location $TemporaryRoot
    try {
        & $node.Source (Join-Path $StagingRoot 'bin\wentian.js') skills list
        if ($LASTEXITCODE -ne 0) { throw 'CLIの起動検証に失敗しました。既存の導入先は変更しません。' }
    } finally { Pop-Location }

    # Keep local secrets/configuration out of the downloaded source replacement.
    $savedEnvironment = $null
    if (Test-Path -LiteralPath (Join-Path $InstallRoot '.env')) {
        $savedEnvironment = Get-Content -LiteralPath (Join-Path $InstallRoot '.env') -Raw
    }
    if (Test-Path -LiteralPath $BackupRoot) {
        throw "以前のバックアップが残っています。内容を確認してから削除してください: $BackupRoot"
    }
    if (Test-Path -LiteralPath $InstallRoot) {
        Move-Item -LiteralPath $InstallRoot -Destination $BackupRoot
    }

    try {
        $installParent = Split-Path -Parent $InstallRoot
        New-Item -ItemType Directory -Path $installParent -Force | Out-Null
        Move-Item -LiteralPath $StagingRoot -Destination $InstallRoot
        if ($null -ne $savedEnvironment) {
            # Windows PowerShell 5.1には`utf8NoBOM`指定がないため、.NET APIで
            # 元の設定内容をUTF-8（BOMなし）として復元します。
            [System.IO.File]::WriteAllText(
                (Join-Path $InstallRoot '.env'),
                $savedEnvironment,
                [System.Text.UTF8Encoding]::new($false)
            )
        }
        elseif (-not (Test-Path -LiteralPath (Join-Path $InstallRoot '.env'))) {
            Copy-Item -LiteralPath (Join-Path $InstallRoot '.env.example') -Destination (Join-Path $InstallRoot '.env')
        }
        $installed = $true
    }
    catch {
        if ((Test-Path -LiteralPath $BackupRoot) -and -not (Test-Path -LiteralPath $InstallRoot)) {
            Move-Item -LiteralPath $BackupRoot -Destination $InstallRoot
        }
        throw
    }

    # A CMD launcher works from both Windows PowerShell and PowerShell 7 without
    # changing the user's PowerShell execution policy.
    New-Item -ItemType Directory -Path $LauncherDirectory -Force | Out-Null
    $launcher = @"
@echo off
node "$InstallRoot\bin\wentian.js" %*
"@
    Set-Content -LiteralPath (Join-Path $LauncherDirectory 'wentian.cmd') -Value $launcher -Encoding ascii
    if (-not $NoPathUpdate) { Add-UserPath $LauncherDirectory }

    if (Test-Path -LiteralPath $BackupRoot) {
        Remove-Item -LiteralPath $BackupRoot -Recurse -Force
    }

    Write-Host ''
    Write-Host 'Wentian Gatewayのインストールが完了しました。' -ForegroundColor Green
    Write-Host "インストール先: $InstallRoot"
    Write-Host '新しいPowerShellを開き、次のコマンドで起動してください:'
    Write-Host '  wentian daemon start --port 8787' -ForegroundColor Yellow
    Write-Host '  wentian daemon status' -ForegroundColor Yellow
}
finally {
    # Staging data is disposable. The active installation is removed here only
    # when it was never published, so a successful install cannot be erased.
    if (Test-Path -LiteralPath $TemporaryRoot) {
        Remove-Item -LiteralPath $TemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (-not $installed -and (Test-Path -LiteralPath $BackupRoot) -and -not (Test-Path -LiteralPath $InstallRoot)) {
        Move-Item -LiteralPath $BackupRoot -Destination $InstallRoot -ErrorAction SilentlyContinue
    }
}
