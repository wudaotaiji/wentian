# 多言語メーカー例の書き出し（Export）をNode.jsで実施します。
# パスをスクリプト位置から求めるため、任意の作業ディレクトリから実行できます。
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path $PSScriptRoot -Parent
# 標準入力でコードを渡し、Windowsの引数解釈による引用符の消失を防ぎます。
$source = @'
import {mkdir,writeFile} from 'node:fs/promises';
import {defaultPublicSite,validatePublicSite,renderPublicHome} from './src/public-site.ts';
import {templateSite} from './src/site-templates.ts';
await mkdir('examples/maker-atelier',{recursive:true});
const site=validatePublicSite(templateSite('maker-atelier',defaultPublicSite,'Wentian Maker Atelier'));
const html=renderPublicHome(site,[],'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
await writeFile('examples/maker-atelier/index.html',html,'utf8');
'@
# 一時的にリポジトリへ移動し、失敗時も元の作業場所へ戻します。
Push-Location $repositoryRoot
try {
    $source | node --import tsx --input-type=module
    if ($LASTEXITCODE -ne 0) { throw '多言語サンプルの書き出しに失敗しました。' }
    Write-Output '多言語サンプルを書き出しました: examples/maker-atelier/index.html'
} finally { Pop-Location }
