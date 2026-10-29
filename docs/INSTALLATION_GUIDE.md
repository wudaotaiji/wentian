# Wentian Gateway 導入手順書

## 1. 製品概要

Wentian Gateway は、複数のローカル AI バックエンドを単一の OpenAI 互換 API にまとめ、PC のリソースに応じて安全に運用するためのローカルファースト基盤です。

- **バージョン**: 0.6.0
- **パッケージ名**: `wentian-gateway`
- **ライセンス**: MIT
- **対応 OS**: Windows（PowerShell 7 推奨）

## 2. 動作環境

### 2.1 必須要件

| 項目 | バージョン | 備考 |
|---|---|---|
| OS | Windows 10/11 (64bit) | PowerShell 7 推奨 |
| Node.js | v24.16.0 以上 | [公式サイト](https://nodejs.org/) からダウンロード |
| npm | 12.0.2 以上 | Node.js に同梱 |

### 2.2 推奨環境

| 項目 | 値 | 備考 |
|---|---|---|
| RAM | 16GB 以上 | ローカルモデル使用時は 32GB 以上推奨 |
| VRAM | 8GB 以上 | GPU 推論を行う場合 |
| ディスク | 利用モデルに応じて確保 | 音声3モデルだけで約4.21GB。Python・PyTorch・取得キャッシュ・成果物の容量は別途必要 |

### 音声・動画制作の追加準備（2026-10-07）

ComfyUIは不要です。`scripts/setup-media-engine.ps1` または `scripts/setup-media-engine.py` で専用PythonとFFmpegを準備し、制作画面 `/media-studio` の「基盤のモデル自動保守」で取得対象を保存します。新規導入の自動取得は全件無効です。起動時と30分ごとに許可済みモデルの不足・容量不一致を修復し、記録した版を維持します。

音声モデルはMusicGen Small約2.37GB、AudioLDM Small v2約1.69GB、Whisper Tiny約0.16GBです。このPCの動画は約1MBの小型検証モデルを使用し、本番LTX約28GBは未取得です。小型モデルに実用映像の生成能力はありません。自動保守の動画を有効にしても、本番モデルへ自動昇格しません。CPUで動作確認済み、NVIDIA CUDAは実機未検証です。[セットアップ・ライセンス・検証範囲](media_production.md)を参照してください。

### 2.3 接続可能なバックエンド

| バックエンド | 説明 | 必須 |
|---|---|---|
| llama.cpp | OpenAI 互換 LLM サーバー | オプション |
| Ollama | OpenAI 互換 LLM サーバー | オプション |
| LM Studio | OpenAI 互換 LLM サーバー | オプション |
| ComfyUI | メディア/ワークフローサービス（Phase 2） | オプション |

## 3. インストール手順

### 3.1 GitHubソースからの導入（開発・ソース実行）

#### ステップ 1: プロジェクトの取得

Git リポジトリからクローンします。

```powershell
# 実行環境: Windows PowerShell / PowerShell 7
# 実行フォルダー: 任意
Set-Location -LiteralPath 'C:\workspace'
git clone https://github.com/wudaotaiji/wentian.git
Set-Location -LiteralPath 'C:\workspace\wentian-gateway'
```

#### ステップ 2: 依存パッケージのインストール

```powershell
# 実行環境: Windows PowerShell / PowerShell 7
# 実行フォルダー: C:\workspace\wentian-gateway
npm ci
py -3 scripts/setup-python.py
npm run build
```

以下のパッケージが自動的にインストールされます：

Python補助処理の依存はルートの `requirements.txt` に集約しています。上記のPython準備コマンドは専用の仮想環境（Virtual Environment） `.venv` へPyYAMLを導入し、実際に読み込めることを検証します。Node.jsの依存だけを導入しても、外部エージェントの接続設定保守は動作しません。Python本体が未導入のWindowsでは、先に `winget install --id Python.Python.3.14 --exact` を実行してください。

| パッケージ | 用途 |
|---|---|
| fastify | HTTP サーバーフレームワーク |
| @fastify/cors | CORS 設定 |
| openai | OpenAI SDK 互換クライアント |
| @opentui/core | UI コンポーネント |
| tsx | TypeScript ランタイム |
| typescript | タイプチェック |

#### ステップ 3: バージョン確認

```powershell
# 実行環境: Windows PowerShell / PowerShell 7
# 実行フォルダー: C:\workspace\wentian-gateway
npm run wentian -- --help
```

### 3.2 任意の作業ディレクトリからの起動（通常利用）

PowerShellからインストーラーを実行します。インストーラーはGitHubからソースを取得し、インストール先で `npm ci` と型検査を完了してからユーザー領域へ配置します。`.env` は更新時に保持します。

```powershell
irm https://raw.githubusercontent.com/wudaotaiji/wentian/main/install.ps1 | iex
```

PowerShellのパイプ実行を避けたい場合はPython版を使用できます。

```powershell
irm https://raw.githubusercontent.com/wudaotaiji/wentian/main/install.py -OutFile "$env:TEMP\wentian-install.py"
py -3 "$env:TEMP\wentian-install.py"
```

インストール後は、新しいPowerShellを開けば作業ディレクトリを問わず起動できます。npmレジストリからのグローバル導入には対応していません。開発時の `npm link` はリンク元のチェックアウトを参照する方式で、通常利用のインストール手順ではありません。

```powershell
Set-Location -LiteralPath 'C:\workspace\games'
wentian --help
```

### 3.3 環境変数の設定

`.env` ファイルを作成し、必要に応じて環境変数を定義します。

```powershell
# 実行環境: Windows PowerShell / PowerShell 7
# 実行フォルダー: C:\workspace\wentian-gateway
Copy-Item -LiteralPath '.env.example' -Destination '.env' -Force
notepad.exe .env
```

主な設定項目：

| 環境変数名 | 説明 | デフォルト |
|---|---|---|
| `WENTIAN_API_KEY` | API 認証キー | 未設定（認証無効） |
| `WENTIAN_PROVIDERS_FILE` | プロバイダー設定ファイルパス | `providers.json` |
| `WENTIAN_ENABLE_STATE_CHANGES` | 状態変更APIの有効化 | `false` |

## 4. 初期設定

### 4.1 プロバイダー設定

外部 OpenAI 互換サービスを `providers.json` で登録します。

```jsonc
// C:\workspace\wentian-gateway\providers.json
{
  "providers": [
    {
      "id": "lmstudio",
      "name": "LM StudioローカルLLM",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "priority": 1,
      "enabled": true,
      "autoRoute": true,
      "autoModels": ["local-model", "local-model", "local-model"]
    }
  ]
}
```

秘密の API キーはファイルへ直接書かず、`apiKeyEnv` で環境変数名を指定してください。

### 4.2 クライアント側設定

#### OpenCode への設定

設定ファイル: `C:\Users\USER\.config\opencode\opencode.jsonc`

```powershell
# バックアップ作成
$OpenCodeConfig = 'C:\Users\USER\.config\opencode\opencode.jsonc'
Copy-Item -LiteralPath $OpenCodeConfig -Destination "$OpenCodeConfig.before-wentian" -Force
notepad.exe $OpenCodeConfig
```

`provider` ブロックへ追加：

```jsonc
"provider": {
  "wentian": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Wentian Gateway",
    "options": {
      "baseURL": "http://127.0.0.1:8787/v1"
    },
    "models": {
      "wentian-auto/local": { "name": "Wentian Auto Local" },
      "wentian-auto/remote": { "name": "Wentian Auto Remote" },
      "wentian-auto/all": { "name": "Wentian Auto All" }
    }
  }
},
"model": "wentian/wentian-auto/remote"
```

#### Kilo への設定

設定ファイル: `C:\Users\USER\.config\kilo\kilo.jsonc`

```powershell
# バックアップ作成
$KiloConfig = 'C:\Users\USER\.config\kilo\kilo.jsonc'
Copy-Item -LiteralPath $KiloConfig -Destination "$KiloConfig.before-wentian" -Force
notepad.exe $KiloConfig
```

`provider` ブロックへ追加（OpenCode と同じ形式）：

```jsonc
"provider": {
  "wentian": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Wentian Gateway",
    "options": {
      "baseURL": "http://127.0.0.1:8787/v1"
    },
    "models": {
      "wentian-auto/local": { "name": "Wentian Auto Local" },
      "wentian-auto/remote": { "name": "Wentian Auto Remote" },
      "wentian-auto/all": { "name": "Wentian Auto All" }
    }
  }
},
"model": "wentian/wentian-auto/remote"
```

## 5. 起動方法

### 5.1 通常起動（フォアグラウンド）

```powershell
# 実行環境: Windows PowerShell / PowerShell 7
# 実行フォルダー: C:\workspace\wentian-gateway
npm run dev
```

Web UI: `http://127.0.0.1:8787/`

停止: 同じ PowerShell 画面で `Ctrl+C`

### 5.2 Daemon 起動（常駐）

```powershell
# 実行環境: Windows PowerShell / PowerShell 7
# 実行フォルダー: C:\workspace\wentian-gateway
npm run wentian -- daemon start --port auto
npm run wentian -- daemon status
npm run wentian -- daemon logs
npm run wentian -- daemon stop
```

PID・ポート・ログは `.wentian/runtime/` で管理されます。

### 5.3 CLI 操作

```powershell
# サーバー起動
npm run wentian -- server --port 8787 --hostname 127.0.0.1

# Agent 実行
npm run wentian -- agent --server http://127.0.0.1:8787
npm run wentian -- agent --web "最新情報を検索して"

# Confluence ログイン
wentian confluence login

# 直接エージェント実行
wentian agent "タスク内容"
```

## 6. 動作確認

### 6.1 Gateway ヘルスチェック

```powershell
# 実行環境: Windows PowerShell / PowerShell 7
# 実行フォルダー: 任意
curl.exe -sS http://127.0.0.1:8787/health
```

### 6.2 モデル一覧確認

```powershell
curl.exe -sS http://127.0.0.1:8787/v1/models
```

PowerShell でモデルIDだけ表示：

```powershell
$Models = curl.exe -sS http://127.0.0.1:8787/v1/models | ConvertFrom-Json
$Models.data | Select-Object -ExpandProperty id
```

### 6.3 チャットテスト

```powershell
curl.exe -sS -X POST http://127.0.0.1:8787/v1/chat/completions `
  -H "Content-Type: application/json" `
  --data-raw '{"model":"wentian-auto/remote","messages":[{"role":"user","content":"OKとのみ回答してください"}],"max_tokens":32,"stream":false}'
```

正常なレスポンス例：

```json
{
  "content": "OK",
  "wentian": {
    "requested_model": "wentian-auto/remote",
    "resolved_model": "lmstudio/local-model",
    "provider": "lmstudio"
  }
}
```

## 7. アップデート方法

### 7.1 ローカルプロジェクトの更新

```powershell
# 実行環境: Windows PowerShell / PowerShell 7
# 実行フォルダー: C:\workspace\wentian-gateway
git pull
npm install
```

### 7.2 通常インストールの更新

PowerShellから公式インストーラーを再実行します。既存の `.env` は保持されます。

```powershell
irm https://raw.githubusercontent.com/wudaotaiji/wentian/main/install.ps1 | iex
```

## 8. トラブルシューティング

### 8.1 ポートが既に使用中

```powershell
# 使用中のポート確認
netstat -ano | findstr :8787

# プロセス終了（PIDは上記で確認した値に置き換え）
Stop-Process -Id <PID> -Force
```

### 8.2 npm install が失敗する

```powershell
# キャッシュクリア
npm cache clean --force
Remove-Item -LiteralPath 'node_modules' -Recurse -Force
Remove-Item -LiteralPath 'package-lock.json' -Force
npm install
```

### 8.3 バックエンドに接続できない

1. バックエンド（Ollama/LM Studio/llama.cpp）が起動しているか確認
2. `providers.json` の `baseUrl` が正しいか確認
3. Firewall でポートが開いているか確認

### 8.4 クライアントから接続できない

1. Gateway が起動しているか `curl.exe -sS http://127.0.0.1:8787/health` で確認
2. クライアントの設定ファイルが正しいか確認
3. Base URL が `http://127.0.0.1:8787/v1` になっているか確認

## 9. アンインストール

### 9.1 グローバルインストールの削除

```powershell
npm uninstall -g wentian-gateway
```

### 9.2 プロジェクトの削除

```powershell
Remove-Item -LiteralPath 'C:\workspace\wentian-gateway' -Recurse -Force
```

### 9.3 設定ファイルの削除

```powershell
# OpenCode 設定復元
$OpenCodeConfig = 'C:\Users\USER\.config\opencode\opencode.jsonc'
Restore-Item -LiteralPath "$OpenCodeConfig.before-wentian" -Destination $OpenCodeConfig -Force

# Kilo 設定復元
$KiloConfig = 'C:\Users\USER\.config\kilo\kilo.jsonc'
Restore-Item -LiteralPath "$KiloConfig.before-wentian" -Destination $KiloConfig -Force
```

## 10. ドキュメント一覧

| ドキュメント | 説明 |
|---|---|
| [README.md](../README.md) | プロジェクト概要、利用イメージ |
| [DOCUMENTATION.md](../DOCUMENTATION.md) | 正式仕様、API 仕様、完成条件 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 全体アーキテクチャ |
| [CLI_REFERENCE.md](./CLI_REFERENCE.md) | CLI コマンドリファレンス |
| [USER_GUIDE.md](./USER_GUIDE.md) | 詳細な利用手順 |
| [公開機能と制限](feature_scope.md) | Git 管理、E2E 受入試験 |
| [公開機能と制限](feature_scope.md) | MCP・A2A 接続方針 |
| [VSCODE_MCP_USAGE.md](./VSCODE_MCP_USAGE.md) | VS Code からの MCP 利用方法 |
