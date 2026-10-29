<#
検証専用サーバー8788に対してPython版のPlaywright検証を実行します。
テンプレート（Template）の大文字URL入力、作成後の編集準備、サイト制作のサブメニュー（Submenu）と、対象行からの確認付き閉鎖、一覧から同一ポートの公開サイトを開く操作も検証します。
実運用サイトを変更しないよう、呼出側が作成した一時フォルダーだけを渡します。
認証値は環境変数で引き継ぎ、コマンドラインやログには出力しません。
#>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference = 'Stop'
# 配列で引数を渡し、フォルダー名を実行コードとして解釈しません。
& uv run --no-project --with playwright python (Join-Path $PSScriptRoot 'verify-site-editor.py') --directory $Directory
exit $LASTEXITCODE
