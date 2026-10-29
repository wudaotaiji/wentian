# 各機能を確認するための完全サンプル

架空の「星見プロジェクトの研修提案」を題材にした資料一式です。

最初に[確認手順書](../../../docs/knowledge_feature_walkthrough.md)を開いてください。画面の場所、準備、入力する質問、期待する結果、設定が必要な機能、後片付けをK01〜K26で説明しています。

```powershell
# リポジトリのルートで実行。保存先は未使用のフォルダーを指定します。
$demoRoot = Join-Path $env:TEMP 'wentian-knowledge-demo-20261022-01'
python scripts/knowledge-demo.py prepare --directory $demoRoot
python scripts/knowledge-demo.py verify --directory $demoRoot
python scripts/knowledge-demo.py serve --directory $demoRoot --port 8899
```

Python標準ライブラリだけで準備・配信できます。PowerShell入口は`scripts/knowledge-demo.ps1`です。配布したPDF・画像・WAVを使うだけなら再生成用の依存は不要です。

最初に取り込むのは`01-policy-ja-v1.md`と`03-training-plan-zh.md`。版2は更新時に置き換えます。正解表・質問原稿・音声照合原稿・manifest・チェックリストは採点用なので、知識庫へ投入しないでください。

- 正解：版1の上限合計120,000円、版2は144,000円。ともに交通費を除きます。
- 表PDF、工程図、画像PDF、日本語の2音声による合成会議音声も付属します。
- URL収集は生成されたdemo接続設定を使用します。通常の公開収集はループバックを拒否します。
- 収集認証値・Cookie・実行時状態は新規のサンプル領域に生成し、本番設定は自動変更しません。
- [checklist.csv](checklist.csv)をコピーして結果を記録します。初期状態はすべて未実施です。

再生成が必要な場合だけ、reportlab・Pillow・PyMuPDF、日本語TrueType/TTCフォント、Windowsの日本語合成音声2種類を用意し、`scripts/knowledge-demo-assets.py --output <新規フォルダー> --font <フォント>`を使います。PowerShell版もあります。合成音声は実会議の話者分離品質を保証するものではありません。
