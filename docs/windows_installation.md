# Windowsへのインストールと初期設定

## 必要な環境

Windows、Node.js 20以降、npmが必要です。通常のオンライン導入にGitHub認証は不要です。公開配布元は`https://github.com/wudaotaiji/wentian`です。モデル接続やAPIキー等の利用者設定は各自の環境で指定してください。

## PowerShell

Windows PowerShellまたはPowerShell 7で実行します。

```powershell
irm https://raw.githubusercontent.com/wudaotaiji/wentian/main/install.ps1 | iex
```

既定では現在ユーザーの`LOCALAPPDATA`配下へ配置し、ユーザーPATHへ起動器を追加します。新しいターミナルを開いて実行してください。

```powershell
wentian setup --port auto
```

画面に表示されるURLを開き、初期管理者を作成してログインします。モデルが未設定の状態で健康APIが503を返す場合と、画面やインストールの失敗は区別してください。モデル応答の確認には利用者のプロバイダー設定が別途必要です。

## Python

Python 3も利用できる場合は、同等のインストーラーを使えます。

```powershell
irm https://raw.githubusercontent.com/wudaotaiji/wentian/main/install.py -OutFile "$env:TEMP\wentian-install.py"
python "$env:TEMP\wentian-install.py"
```

## ソース導入と隔離検証

取得済みのGitソースから実行する場合は`install.ps1 -SourceDirectory .`、または`python install.py --source-directory .`を指定します。

既存インストールやPATHへ影響させない検証には、空の専用領域を指定します。

```powershell
.\install.ps1 -InstallRoot "$env:TEMP\Wentian clean test" -NoPathUpdate
# Python版
python install.py --install-root "$env:TEMP\Wentian Python test" --no-path-update
```

この場合の起動器は指定ディレクトリ名に`-bin`を付けた隣接ディレクトリへ保存します。検証用の`.env`、認証台帳、保存先も通常利用と共有しないでください。

## 問題の切り分け

| 状況 | 確認すること |
|---|---|
| スクリプトやZIPが404 | 上記の公開配布URLを使っているか。私有リポジトリは匿名では取得できません |
| npmの出力が止まって見える | 別の端末でnpmキャッシュのログを確認。ダウンロード進行中に重複インストールを開始しない |
| 依存インストールが失敗 | Node/npmの版、ネットワーク、プロキシ、空き容量を確認。ログへ秘密値を含めて公開しない |
| 起動器が見つからない | 新しいターミナルでPATHを再取得。隔離導入では隣接する`-bin`内の`wentian.cmd`を直接指定 |
| プラグイン清単が見つからない | `WENTIAN_PLUGIN_MANIFEST`等の明示設定と導入先を確認。未設定時はインストール先の清単を使用 |
| ポートを使用できない | `--port auto`を使用。別の稼働サービスを停止して解決しない |
| モデルへ接続できない | [利用ガイド](USER_GUIDE.md)と[ローカルLLM設定](LOCAL_LLM_CONFIGURATION.md)を確認 |

インストーラーは固定されたnpm依存と型検査、導入先外からのCLI読込みを確認してから配置します。初期設定画面の表示と、モデルやすべての業務機能の実機検証は別の確認です。
