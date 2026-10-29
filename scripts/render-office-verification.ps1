<#
隔離したOffice成果を、インストール済みMicrosoft Officeのファイル変換APIでPDFへ変換します。
入力はローカルの検収用コピーだけを指定してください。原本は読取専用で開き、保存しません。
新規出力ディレクトリを必須にし、マクロ・外部リンク更新・最近使ったファイルへの追加を抑制します。
既存のOfficeプロセスへ接続せず、この処理で作成したCOMインスタンスだけを終了します。
画面の人間検収や編集操作の検収を、このPDF変換だけで合格にはしません。
#>
param(
    [Parameter(Mandatory = $true)][string[]]$InputFiles,
    [Parameter(Mandatory = $true)][string]$Output
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# 親プロセスのPSModulePathに依存せず、Windows PowerShell 5.1でもハッシュを計算します。
function Get-VerificationHash([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try { return [System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','') }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
$renderOutput = [System.IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $renderOutput) { throw '上書きを避けるため、新規の出力先を指定してください。' }
$renderInputs = @($InputFiles | ForEach-Object {
    $resolved = (Resolve-Path -LiteralPath $_).Path
    if ([System.IO.Path]::GetExtension($resolved) -notin '.docx','.xlsx','.pptx') { throw '対応形式はDOCX・XLSX・PPTXです。' }
    $resolved
})
if (@($renderInputs | ForEach-Object { [System.IO.Path]::GetFileNameWithoutExtension($_) + '-' + [System.IO.Path]::GetExtension($_).Substring(1) } | Select-Object -Unique).Count -ne $renderInputs.Count) { throw '同名の出力になる入力は分けて実行してください。' }
New-Item -ItemType Directory -Path $renderOutput | Out-Null
$renderResults = @()
foreach ($renderInput in $renderInputs) {
    # PowerShellのラップ値を外し、COMの引数として文字列をそのまま渡します。
    $renderInput = [string]$renderInput
    $officeApp = $null
    $officeDocument = $null
    $renderExtension = [System.IO.Path]::GetExtension($renderInput).ToLowerInvariant()
    $renderPdf = Join-Path $renderOutput ([System.IO.Path]::GetFileNameWithoutExtension($renderInput) + '-' + $renderExtension.Substring(1) + '.pdf')
    $renderBeforeHash = Get-VerificationHash $renderInput
    try {
        switch ($renderExtension) {
            '.docx' {
                $officeApp = New-Object -ComObject Word.Application
                $officeApp.Visible = $false
                $officeApp.DisplayAlerts = 0
                $officeApp.AutomationSecurity = 3
                Write-Output 'Wordで検収用コピーを読み込みます。'
                # COMへ渡す値は明示的に型変換し、PowerShellのラップ値による待機を避けます。
                $officeDocument = $officeApp.Documents.Open([string]$renderInput,[bool]$false,[bool]$true,[bool]$false)
                # 読取専用で開いた文書をそのままPDFへ出力し、原本は保存も上書きもしません。
                # 中間のDOCX保存は行わず、変換対象とPDFの対応だけを記録します。
                Write-Output 'WordでPDFを出力します。'
                $officeDocument.ExportAsFixedFormat([string]$renderPdf,[int]17)
            }
            '.xlsx' {
                $officeApp = New-Object -ComObject Excel.Application
                $officeApp.Visible = $false
                $officeApp.DisplayAlerts = $false
                $officeApp.AskToUpdateLinks = $false
                $officeApp.AutomationSecurity = 3
                $officeDocument = $officeApp.Workbooks.Open([string]$renderInput,[int]0,[bool]$true)
                # 印刷設定をここで修正せず、製品が出力したままの配置を検査します。
                $officeDocument.ExportAsFixedFormat([int]0,[string]$renderPdf)
            }
            '.pptx' {
                $officeApp = New-Object -ComObject PowerPoint.Application
                $officeApp.AutomationSecurity = 3
                $officeDocument = $officeApp.Presentations.Open([string]$renderInput,[bool]$true,[bool]$false,[bool]$false)
                $officeDocument.SaveAs([string]$renderPdf,[int]32)
            }
        }
        if (!(Test-Path -LiteralPath $renderPdf)) { throw 'PDFが作成されませんでした。' }
        if ((Get-VerificationHash $renderInput) -ne $renderBeforeHash) { throw '入力の変更を検出しました。' }
        $renderResults += [pscustomobject]@{ input=$renderInput; pdf=$renderPdf; sourceHash=$renderBeforeHash; originalUnchanged=$true }
        Write-Output ('変換完了: ' + [System.IO.Path]::GetFileName($renderInput))
    } finally {
        if ($null -ne $officeDocument) {
            if ($renderExtension -eq '.docx') { $officeDocument.Close(0) }
            elseif ($renderExtension -eq '.xlsx') { $officeDocument.Close($false) }
            else { $officeDocument.Close() }
            [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($officeDocument)
        }
        if ($null -ne $officeApp) {
            $officeApp.Quit()
            [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($officeApp)
        }
    }
}
$renderResults | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $renderOutput 'conversion.json') -Encoding utf8
