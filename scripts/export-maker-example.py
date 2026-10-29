"""メーカーの多言語サンプルを静的HTML（Static HTML）として書き出します。"""
from pathlib import Path
import subprocess

# スクリプトの位置からリポジトリを特定し、呼び出し元の作業場所に依存させません。
root = Path(__file__).resolve().parents[1]
# 通常の保存検証を通すことで、公開ページと同じ安全なHTMLを生成します。
# 標準入力でJavaScriptを渡し、Windowsシェルによる引用符の解釈を避けます。
source = '''
import {mkdir,writeFile} from 'node:fs/promises';
import {defaultPublicSite,validatePublicSite,renderPublicHome} from './src/public-site.ts';
import {templateSite} from './src/site-templates.ts';
const directory='examples/maker-atelier';
await mkdir(directory,{recursive:true});
const site=validatePublicSite(templateSite('maker-atelier',defaultPublicSite,'Wentian Maker Atelier'));
const html=renderPublicHome(site,[],'').replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi,'');
await writeFile(directory+'/index.html',html,'utf8');
'''
# エラーを成功として扱わず、呼び出し元へ終了状態を返します。
subprocess.run(['node', '--import', 'tsx', '--input-type=module'],
               input=source, encoding='utf-8', cwd=root, check=True)
print('多言語サンプルを書き出しました: examples/maker-atelier/index.html')
