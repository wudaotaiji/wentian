# Wentian Gateway ローカル取得・インストール手順

## 1. 概要

この手順では、非公開GitHubリポジトリからWentian GatewayをWindows PCへ取得し、依存パッケージの導入、設定、起動、動作確認まで行います。

- リポジトリ: <https://github.com/wudaotaiji/wentian>
- 標準配置先: `C:\workspace\wentian-gateway`
- 既定ブランチ: `main`
- 実行環境: Windows、PowerShell 7
- プロジェクトで確認済みのランタイム: Node.js v24系、npm v12系

リポジトリは非公開です。取得には、アクセス権を持つGitHubアカウントでの認証が必要です。

## 2. 前提ソフトウェア

PowerShellでGit、Node.js、npmの導入状況を確認します。

```powershell
# Git、Node.js、npmのバージョンを確認します。
git --version
node --version
npm --version
```

未導入の場合は、Winget（ウィンゲット / Windows Package Manager）を使ってインストールできます。

```powershell
# Gitをインストールします。
winget install --exact --id Git.Git

# Node.jsをインストールします。
winget install --exact --id OpenJS.NodeJS
```

インストール後はPowerShellを開き直し、もう一度バージョンを確認してください。

## 3. リポジトリの取得

```powershell
# プロジェクトを配置する親フォルダーへ移動します。
Set-Location -LiteralPath 'C:\workspace'

# GitHubからリポジトリを取得します。
git clone 'https://github.com/wudaotaiji/wentian.git' 'wentian-gateway'

# 取得したプロジェクトへ移動します。
Set-Location -LiteralPath 'C:\workspace\wentian-gateway'
```

認証画面が表示された場合は、このリポジトリへのアクセス権を持つGitHubアカウントでログインします。

取得結果を確認します。

```powershell
# 現在のブランチと作業ツリーの状態を確認します。
git status --short --branch

# 登録された取得元を確認します。
git remote -v
```

## 4. 初回セットアップ

```powershell
# Wentian Gatewayのプロジェクトへ移動します。
Set-Location -LiteralPath 'C:\workspace\wentian-gateway'

# Node.jsの依存パッケージをインストールします。
npm install

# 環境設定のひな型からローカル設定ファイルを作成します。
Copy-Item -LiteralPath '.env.example' -Destination '.env'

# TypeScript（タイプスクリプト / TypeScript）の型検査を実行します。
npm run build

# 単体テストを実行します。
npm test
```

`.env`はGit管理対象外です。LAN（ローカルエリアネットワーク / Local Area Network）やWAN（広域ネットワーク / Wide Area Network）へ公開しない場合は、既定値の`WENTIAN_HOST=127.0.0.1`を維持します。

## 5. AIバックエンドの準備

Wentian Gateway自体にはAIモデルが含まれていません。必要に応じて、少なくとも1つのバックエンドを起動します。

| バックエンド | 既定の接続先 |
|---|---|
| llama.cpp | `http://127.0.0.1:8080/v1` |
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| ComfyUI | `http://127.0.0.1:8188` |

ローカル接続先は`.env`、外部プロバイダー（Provider）は`providers.json`で設定します。APIキーは`providers.json`へ直接書かず、`.env`または環境変数に保存してください。

## 6. Gatewayの起動と停止

### フォアグラウンド起動

```powershell
# Wentian Gatewayをフォアグラウンドで起動します。
Set-Location -LiteralPath 'C:\workspace\wentian-gateway'
npm run dev
```

起動後、Web Control Center（ウェブ・コントロールセンター / Web Control Center）を開きます。

```text
http://127.0.0.1:8787/
```

停止する場合は、起動したPowerShellで`Ctrl+C`を押します。

### バックグラウンド起動

```powershell
# 空いているポートを自動選択してDaemon（デーモン / Daemon）を起動します。
npm run wentian -- daemon start --port auto

# Daemonの状態を確認します。
npm run wentian -- daemon status

# Daemonを停止します。
npm run wentian -- daemon stop
```

## 7. 動作確認

Gatewayを起動した状態で、別のPowerShellから確認します。

```powershell
# Gateway自体の稼働状態を確認します。
curl.exe -sS 'http://127.0.0.1:8787/health'

# 利用可能なモデルを確認します。
curl.exe -sS 'http://127.0.0.1:8787/v1/models'

# 登録済みプロバイダーを確認します。
curl.exe -sS 'http://127.0.0.1:8787/v1/providers'
```

`/health`は成功しても、利用可能なAIバックエンドがなければチャット要求はHTTP `503`になることがあります。

## 8. 更新方法

```powershell
# プロジェクトへ移動します。
Set-Location -LiteralPath 'C:\workspace\wentian-gateway'

# 未コミットの変更がないことを確認します。
git status --short

# mainブランチを早送り可能な場合だけ更新します。
git pull --ff-only

# 依存関係を更新し、型検査とテストを実行します。
npm install
npm run build
npm test
```

未コミットの変更が表示された場合は、更新前に変更をコミットするか、安全に退避してください。

## 9. トラブルシューティング

### GitHubから取得できない

- GitHubアカウントがリポジトリへのアクセス権を持っているか確認します。
- ブラウザー認証が表示された場合は、正しいGitHubアカウントでログインします。
- 社内ネットワーク、Proxy（プロキシ / Proxy）、VPNの接続条件を確認します。

### Gatewayへ接続できない

```powershell
# 8787番ポートの待ち受け状態を確認します。
Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue

# HTTPステータスを含めてHealth APIを確認します。
curl.exe -sS -i 'http://127.0.0.1:8787/health'
```

### HTTP 503になる

```powershell
# バックエンドごとの状態を表形式で確認します。
$Health = curl.exe -sS 'http://127.0.0.1:8787/health' | ConvertFrom-Json
$Health.providers | Format-Table id,kind,ok,status,latencyMs,error
```

少なくとも1つのLLMプロバイダーが`ok: true`になるよう、Ollama、LM Studio、llama.cpp、または外部プロバイダーを起動・設定します。
