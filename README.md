# Wentian Gateway Control Center

WentianはローカルAI、外部エージェント（External Agent）、サイト管理、メール処理をまとめる共通基盤です。利用者が接続先を設定し、特定の導入企業のサービスへ依存せずに実行できます。

オープンソースの公開候補と設定の移行については、[公開準備](docs/OPEN_SOURCE_RELEASE.md)を参照してください。ライセンス（License）は[MIT](LICENSE)です。

過去の日付付き資料は開発時点の記録です。そこで示す実環境の検証画像・ログは公開対象から除去しており、現在の利用環境での成功を保証するものではありません。

## 共有成果を一つ作る

資料を参照して回答・成果物を作る場合は、会話のツール設定でプロジェクト知識庫を選択できます。AIが検索語を判断し、出典・引用・改訂付きで回答します。埋め込みモデルを設定するとベクトル・ハイブリッド検索を利用でき、`/projects`から公開・認証付きURL、PDF・画像・音声、JavaScript生成本文を収集し、継続クロール・定期同期を登録できます。接続先と必要な抽出モデルは利用者が設定します。利用手順、WorkBuddy＋ima知識庫に近い構成との比較、実装範囲は[作業Agentと知識庫の連携](docs/project_knowledge_agent.md)を参照してください。

`/projects`には、資料の一括投入、根拠の意味を検証する回答・提案作成、知識庫への再保存、編集可能なWord・Excel・PowerPoint出力を追加しています。一般メンバーの回答利用、権限を限定したAIグループ接続、会議資料の追加、索引作成・再開、資料本文のバックアップ・復元も利用できます。実資料・実モデルの品質検収にはPython／PowerShellの[検収補助](scripts/knowledge-acceptance.py)を用意しています。模擬試験の成功と、実環境での品質保証は区別します。

各機能を実際に確認する場合は、[サンプル確認手順書（26ケース）](docs/knowledge_feature_walkthrough.md)と[架空の資料一式](examples/knowledge/demo/README.md)を使用してください。日本語・中国語、表PDF、工程図、画像PDF、合成会議音声、更新・認証失効を再現するローカル配信補助、未実施状態の記録表を用意しています。

PDFは一時ブラウザー内のPDF.jsで文字抽出・画像化します。PlaywrightのChromiumを準備するか、`WENTIAN_KNOWLEDGE_BROWSER_EXECUTABLE`で利用するブラウザーを指定してください。スキャン画像の認識には別途Visionモデルが必要です。[公開機能と制限](docs/feature_scope.md)を参照してください。

1. 管理者でログインし、書房を起動します。保存先は管理者ごとの個人領域です。
2. 群にAIメンバーを登録し、会話の進め方を「成果作成」にします。
3. 参加者として依頼を投稿します。目的、必要な条件、利用できる資料を記載すると検証しやすくなります。
4. 成果ボードで完成条件、担当、検証記録、未解決事項を確認します。
5. 保存リンクから書房の成果文書を開きます。保存失敗時は管理者が保存を再試行できます。

「AI検証済み・人間未承認」はAIによる条件照合の結果です。出典と本文を確認して採否を判断してください。暫定・確認待ち・中断は完成と区別します。

詳細は[公開機能と制限](docs/feature_scope.md)、[個人書房](docs/personal_studies_menu_policy.md)、[公開機能と制限](docs/feature_scope.md)を参照してください。会議・遠隔支援の実カメラ、相手PCへの実入力、インターネット越しのTURN接続は実機検収が残っています。

## メール・SES業務の全体方針

Wentianを共通AI基盤、mail-solutionsを直近メールの取得・分類・抽出の入口、BusinessRecordsを経営・営業業務の処理先と位置づけます。役割分担、現行実装との差分、全件取得・学習の扱い、実装の優先順位は[公開機能と制限](docs/feature_scope.md)を参照してください。

## 2026-10-07: サイト管理・Personal Cloud・音声と動画の制作

本日の実装、検証結果、残条件は [公開機能と制限](docs/feature_scope.md) を参照してください。サイト一覧から編集・閉鎖・完全削除を操作できます。`/media-studio` では読み上げ、BGM・効果音、文字起こし、素材編集、音声付き動画と保存例を利用できます。`/videos` はComfyUIに依存せずLTXを直接実行します。現在導入した小型動画モデルは検証専用で、文章に沿った実用映像は生成できません。

- [サイト制作](docs/site_creation.md)・[一覧と削除](docs/site_list_lifecycle.md)
- [Personal Cloudの実装・未完了条件](docs/personal_cloud_implementation.md)
- [公開機能と制限](docs/feature_scope.md)
- [動画生成](docs/video_generation.md)・[音声制作とモデル自動保守](docs/media_production.md)
- [公開機能と制限](docs/feature_scope.md)・[すぐ確認できる制作例](examples/media/README.md)

類似製品との比較、P0～P2の改善仕様、実装・検収結果は[公開機能と制限](docs/feature_scope.md)を参照してください。作業状況は `/operations`、並列工程の編集・再試行は `/workflows`、プロジェクト権限・キー・資料検索は `/projects` から利用できます。

実行方式、許可ファイル、成否通知、ホスト受入試験については[公開機能と制限](docs/feature_scope.md)を参照してください。

能力の対応範囲と次の必須改善目標は[公開機能と制限](docs/feature_scope.md)にまとめています。

許可範囲の既定値・証拠保存などの[公開機能と制限](docs/feature_scope.md)と、Git保存済みの原資料も確認できます。

## 2026-10-01: 公開トップ・タイル共同デザイン・グループ拡張

管理画面と工作台に機能別メニュー、3言語と7スタイルを追加しました。公開トップは80番で配信し、管理者はタイルの自由配置・コード編集・正常確認済みAgentとの共同デザインを行えます。グループには専門メンバー自動追加、人間の参加・画像・ニックネーム、Plan／Action、公開／閉鎖を追加しました。最終仕様、検証済み範囲と未確認事項は [公開機能と制限](docs/feature_scope.md) を参照してください。

## AI会話グループ（Group）

工作台で主題に合う専門メンバーを自動追加し、名前・役割・会話モデルを自由に追加・編集・削除できます。人間も参加・投稿・退出できます。選択したAI同士が履歴を共有して議論し、追加の議題で続行できます。CLIは `wentian group create "相談室"` から利用できます。詳細は [AI会話グループガイド](./docs/AGENT_GROUPS.md) を参照してください。

## タスク予約・定期実行

`wentian schedule add --at "2026-10-02T18:00:00+09:00" --prompt "依頼文"` で指定日時、`--every 30m` で一定間隔、`--daily 09:00 --timezone Asia/Tokyo` で毎日の実行を予約できます。Gatewayの稼働中に処理します。一覧・一時停止・再開・削除、ログの保存にも対応します。詳細は [タスク予約ガイド](./docs/TASK_SCHEDULER.md) を参照してください。

## 0.6.0: Task Workbench

`wentian setup --port auto` で初回設定とタスク工作台を開けます。モデル接続、応答確認、サンプル作成、タスク実行、成果物の検証、指示修正と再開を1つの画面で操作できます。

Skillsは `wentian skills list` / `wentian skills show NAME` / `wentian skills install FILE` で利用できます。詳細と検証範囲は [0.6.0 リリースノート](./docs/RELEASE_0.6.0.md)、実施したテストは [公開機能と制限](docs/feature_scope.md) を参照してください。

Wentian は、複数のローカル AI バックエンドを単一の OpenAI 互換 API にまとめ、PC のリソースに応じて安全に運用するためのローカルファースト基盤です。

CLIの通常会話は、AIが一回の推論で直接回答するか作業計画を返します。挨拶や一般的な相談ではPlanner・制作編排を別途起動しません。調査・実行が必要と判断された場合だけ既存のツール・権限・検収経路へ進みます。明示した実行方式、画像、Web指定、予算付き実行は専用経路を保持します。詳細と検証範囲は[公開機能と制限](docs/feature_scope.md)を参照してください。

CLI入力欄は `/theme blue|slate|green|purple|none` で背景を選択・保存できます。入力の上にはAgent選択設定、Session、添付画像数、前回の実行者・時間とキー操作を表示します。[公開機能と制限](docs/feature_scope.md)を参照してください。

## Windowsへワンラインインストール

公開ダウンロードが404になる場合は、リポジトリーの公開状態とURLを確認してください。取得済みのGitソースから導入する場合は次を使えます（Node.js 20以降、npm、Gitが必要）。

```powershell
.\install.ps1 -SourceDirectory .
# Python版: python install.py --source-directory .
```

検証用の隔離導入は `-InstallRoot "C:\temp\wentian test" -NoPathUpdate`（Python版: `--install-root` / `--no-path-update`）で実行できます。ローカル導入はGit追跡済みソースとその作業変更を使用し、未追跡ファイルを含めません。手順と既知の制約は[Windows導入ガイド](docs/windows_installation.md)を参照してください。


Windows PowerShellまたはPowerShell 7で、次のコマンドを実行します。Node.js 20以降とnpmが必要です。

```powershell
irm https://raw.githubusercontent.com/wudaotaiji/wentian/main/install.ps1 | iex
```

インストール後に新しいPowerShellを開き、Gatewayを起動します。

```powershell
wentian daemon start --port 8787
wentian daemon status
wentian doctor
```

`wentian doctor`は、Daemon、Health、モデル一覧、MCP（モデルコンテキストプロトコル / Model Context Protocol）、Provider設定、OpenCode／Kilo設定、外部Agentキャッシュを読み取り専用で一括診断します。自動化で利用する場合は`wentian doctor --json`、別URLを診断する場合は`wentian doctor --server http://127.0.0.1:8787`を使用できます。重大な異常がある場合は終了コード1を返します。

OpenCode Webと同様に、サーバーを起動して既定ブラウザーで対話画面を開く場合は次を実行します。Control Center上部のWentian Chatでは、モデル選択、複数ターン会話、SSE（サーバー送信イベント / Server-Sent Events）によるストリーミング表示、新しい会話への切替ができます。

```powershell
wentian web
wentian web --port auto --hostname 127.0.0.1
```

ブラウザーを自動起動しない場合は`--no-open`、追加のCORS（オリジン間リソース共有 / Cross-Origin Resource Sharing）Originを許可する場合は`--cors https://example.internal`を指定します。

既定のインストール先は `%LOCALAPPDATA%\Programs\wentian-gateway` です。再度同じワンラインを実行すると更新され、既存の `.env` は保持されます。インストーラーは `npm ci` とTypeScriptの型検査が成功した内容だけを配置します。

PowerShellのパイプ実行を避ける場合、Python 3で次の手順も利用できます。

```powershell
irm https://raw.githubusercontent.com/wudaotaiji/wentian/main/install.py -OutFile "$env:TEMP\wentian-install.py"
python "$env:TEMP\wentian-install.py"
```

ソースから導入・開発する場合は公開GitHubリポジトリをCloneし、`npm ci`でロックファイル（Lockfile）に固定された依存関係を導入します。`npm link`は開発用で、リンク元のチェックアウトを直接実行します。通常利用では上記の公式インストーラーを使用してください。Wentianはnpmレジストリからは配布していません。

Pythonの補助処理は `requirements.txt` で管理します。`py -3 scripts/setup-python.py` はプロジェクト専用の仮想環境（Virtual Environment） `.venv` を作成し、必須ライブラリを一括導入します。自動保守は同じ環境を使用します。PowerShell版は `powershell -ExecutionPolicy Bypass -File scripts/setup-python.ps1`、Linux・macOSでは `python3 scripts/setup-python.py` を使用できます。

## 開発へ参加する

Wentian GatewayへのIssue（課題 / Issue）、改善提案、ドキュメント修正、Pull Request（変更提案 / Pull Request）を歓迎します。小さな修正や質問だけでも参加できます。

開発版をローカルへClone（複製 / Clone）する基本手順は次のとおりです。

```powershell
Set-Location -LiteralPath 'C:\workspace'
git clone https://github.com/wudaotaiji/wentian.git
Set-Location -LiteralPath 'C:\workspace\wentian-gateway'
Copy-Item -LiteralPath '.env.example' -Destination '.env'
npm ci
npm run build
npm test
npm run dev
```

リポジトリへ直接Push（送信 / Push）する権限がない場合は、GitHub上でFork（自分用の複製 / Fork）してから作業ブランチを作成し、Pull Requestを送ってください。詳しい環境要件、ブランチ運用、テスト、Pull Requestの提出方法は [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

開発は次の 2 フェーズで進めます。

1. **Phase 1: 軽量 Gateway（ゲートウェイ / Gateway）** — 接続先の一本化、モデルの明示選択、障害時フォールバックを完成させる。
2. **Phase 2: ローカル AI Manager（マネージャー / Manager）** — RAM/VRAM、能力、ロード状態を判断し、モデルのロード・アンロードまで安全に管理する。

詳細な仕様、完成条件、現状との差分は [DOCUMENTATION.md](./DOCUMENTATION.md) を参照してください。

## ドキュメント

- [公開機能と制限](docs/feature_scope.md) — AI判断と決定論的Safety Gateの責務境界

- [開発参加ガイド](./CONTRIBUTING.md) — Clone、環境構築、Issue、ブランチ、テスト、Pull Request
- [公開機能と制限](docs/feature_scope.md) — 始業、ブランチ作成、Commit、Push、Pull Request、終業時確認
- [行動規範](./CODE_OF_CONDUCT.md) — 誰もが安心して参加するためのコミュニティルール
- [公開機能と制限](docs/feature_scope.md) — 実装済みMCPと実験段階のA2A
- [MCPクライアント利用方法](./docs/MCP_CLIENT_USAGE.md) — 外部ツール・資料接続、管理画面・CLI・単発承認・Agent読み取り統合
- [MCP実装仕様](./docs/MCP_IMPLEMENTATION_SPEC.md) — 通信、認証、対応機能と制限
- [VS Code からの MCP 利用方法](./docs/VSCODE_MCP_USAGE.md) — VS Code の MCP クライアントからの接続手順とツール一覧
- [公開機能と制限](docs/feature_scope.md) — View・OLAP作成サイクル、パトロールAPI、推奨MCP Tool
- [全体アーキテクチャー](./docs/ARCHITECTURE.md) — コンポーネント、要求フロー、安全判定、状態変更境界
- [利用手順書](./docs/USER_GUIDE.md) — 初回セットアップ、設定、起動、OpenCode／Kilo、API、障害確認
- [CLI・Agent機能仕様](./docs/CLI_REFERENCE.md) — Agent、Server、Daemon、多行入力、Web・Confluence検索
- [公開機能と制限](docs/feature_scope.md) — 役割、モデル管理、Agent、MCP、権限、推奨併用構成
- [公開機能と制限](docs/feature_scope.md) — CLI再検出、負キャッシュ回復、Cooldown解除、Fallback Health
- [公開機能と制限](docs/feature_scope.md) — Planner、Task 分割、Agent への委譲、実行、結果統合
- [公開機能と制限](docs/feature_scope.md) — GitHub運用、受入試験、Kilo遅延の調査結果
- [正式仕様](./DOCUMENTATION.md) — Phase 1／Phase 2、API、セキュリティ、設定契約

## 対象バックエンド

- **llama.cpp** — OpenAI 互換 LLM サーバー
- **Ollama** — OpenAI 互換 LLM サーバー
- **LM Studio** — OpenAI 互換 LLM サーバー
- **Wentian制作エンジン** — Diffusers LTX、MusicGen、AudioLDM、Whisper、Windows音声、FFmpeg。ComfyUI不要
- **ComfyUI** — 既存の任意接続。新しい動画・音声制作の必須条件ではない

## Phase 1 の利用イメージ

Kilo、OpenCode などのクライアントには、次の Base URL（ベース URL）を設定します。

```text
http://127.0.0.1:8787/v1
```

このURLは、Wentian Gatewayを起動している同じWindows PCから接続する場合の値です。Kilo/OpenCodeを別PCで動かす場合、`127.0.0.1`はその別PC自身を指すため使用できません。その場合はGatewayの待受・認証・ファイアウォールを明示的に構成してください。

### OpenCodeへ設定する

- 実行環境: Windows PowerShell
- 設定ファイル: `C:\Users\USER\.config\opencode\opencode.jsonc`
- 設定フォルダー確認コマンド: `opencode debug paths`
- 現在の確認済みCLI: OpenCode `7.5.6`

編集前にバックアップします。

```powershell
# 実行環境: Windows PowerShell / PowerShell 7
# 実行フォルダー: 任意
$OpenCodeConfig = 'C:\Users\USER\.config\opencode\opencode.jsonc'
Copy-Item -LiteralPath $OpenCodeConfig -Destination "$OpenCodeConfig.before-wentian" -Force
notepad.exe $OpenCodeConfig
```

既存のルートオブジェクト内にある `provider` オブジェクトへ、次の `wentian` 定義を追加します。既に `wentian` がある場合は、そのブロックだけを次の内容へ置き換えてください。

```jsonc
"wentian": {
  "npm": "@ai-sdk/openai-compatible",
  "name": "Wentian Gateway",
  "options": {
    "baseURL": "http://127.0.0.1:8787/v1"
  },
  "models": {
    "wentian-auto/local": {
      "name": "Wentian Auto Local"
    },
    "wentian-auto/remote": {
      "name": "Wentian Auto Remote"
    },
    "wentian-auto/all": {
      "name": "Wentian Auto All"
    }
  }
}
```

最小構成のファイル全体を新規作成する場合は、次をコピーできます。既存設定がある環境ではファイル全体を上書きせず、上記の `wentian` ブロックだけをマージしてください。

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
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
}
```

保存後、新しいPowerShellで設定とモデルを確認します。

```powershell
# 実行環境: Windows PowerShell / PowerShell 7
# 実行フォルダー: 任意
opencode debug config
opencode models wentian

# 外部サービスだけを自動選択して実行
opencode run --model wentian/wentian-auto/remote "OKとのみ回答してください"

# ローカルと外部サービスを横断して自動選択
opencode run --model wentian/wentian-auto/all "OKとのみ回答してください"
```

### Kiloへ設定する

- 実行環境: Windows PowerShell
- 設定ファイル: `C:\Users\USER\.config\kilo\kilo.jsonc`
- 設定フォルダー確認コマンド: `kilo debug paths`
- 現在の確認済みCLI: Kilo `7.5.6`

編集前にバックアップします。

```powershell
# 実行環境: Windows PowerShell / PowerShell 7
# 実行フォルダー: 任意
$KiloConfig = 'C:\Users\USER\.config\kilo\kilo.jsonc'
Copy-Item -LiteralPath $KiloConfig -Destination "$KiloConfig.before-wentian" -Force
notepad.exe $KiloConfig
```

Kiloのルートオブジェクトへも、OpenCodeと同じ形式の `provider` 定義を追加します。既存の `permission` などは削除せず保持してください。

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

例えば既存のKilo設定が `permission` だけを持つ場合、ルートは次の並びになります。

```jsonc
{
  "$schema": "https://app.kilo.ai/config.json",
  "permission": {
    // 既存設定をそのまま残す
  },
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
}
```

保存後に確認します。

```powershell
# 実行環境: Windows PowerShell / PowerShell 7
# 実行フォルダー: 任意
kilo config check
kilo models wentian

# 外部サービスだけを自動選択して実行
kilo run --model wentian/wentian-auto/remote "OKとのみ回答してください"

# ローカルと外部サービスを横断して自動選択
kilo run --model wentian/wentian-auto/all "OKとのみ回答してください"
```

### Gateway認証を有効にした場合

`.env`で `WENTIAN_API_KEY`を設定した場合は、Kilo/OpenCodeの `options`にも同じ値を設定します。

```jsonc
"options": {
  "baseURL": "http://127.0.0.1:8787/v1",
  "apiKey": "ここをWENTIAN_API_KEYと同じ値に置き換える"
}
```

APIキーを設定ファイルへ直接保存したくない場合は、クライアントが対応する環境変数展開または認証ストアを利用してください。

モデルを明示する場合:

```text
llamacpp/<model-id>
ollama/<model-id>
lmstudio/<model-id>
```

ローカルモデルの自動フォールバックを利用する場合:

```text
wentian-auto/local
```

登録済みの外部サービスだけで自動ルーティングする場合:

```text
wentian-auto/remote
```

ローカルと外部サービスの両方を候補にする場合:

```text
wentian-auto/all
```

`wentian-auto/local` は「最適なモデル」や「無料」を保証する名前ではありません。Phase 1 では、利用可能なローカル候補をポリシーに従って順に試す仮想モデルです。従来の `wentian-auto/free` は互換エイリアスとして扱いますが、廃止予定であり、無料判定は行いません。

通常チャットでGatewayへ接続できない場合、または利用可能なローカルLLMが0件の場合、CLIは処理を終了せず、Health Cacheで利用可能な外部Agentを最大3候補まで直列に試します。最初に成功した応答を採用し、失敗・Timeout時は次候補へ引き継ぎます。天気・為替などの取得結果もAgentへ渡して回答を生成します。

## 複数外部サービスの登録

ローカルのOpenAI互換サービスは [providers.json](./providers.json) で複数同時に管理します。既定の接続先は次の2サービスです。

| Provider ID | Base URL | 自動ルーティング |
|---|---|---|
| `lmstudio` | `http://127.0.0.1:1234/v1` | 有効 |
| `ollama` | `http://127.0.0.1:11434/v1` | 有効 |

既定のローカルモデル設定とWorkflow integration・Confluenceの接続方法は[ローカルLLM設定仕様](./docs/LOCAL_LLM_CONFIGURATION.md)を参照してください。

`providers.json`では、`id`、`scope`、`baseUrl`、`priority`、`enabled`、`autoRoute`、`autoModels`、`maxRequestsPerMinute`、能力スコアを指定できます。秘密のAPIキーはファイルへ直接書かず、`apiKeyEnv`へ環境変数名を指定してください。`WENTIAN_PROVIDERS_FILE`で別の設定ファイルも選択できます。

## 主要 API

| メソッド | パス | 役割 |
|---|---|---|
| `GET` | `/health` | Gateway 自体のヘルス確認 |
| `GET` | `/v1/models` | 仮想モデルと検出済みモデルの一覧 |
| `GET` | `/v1/providers` | プロバイダー設定と状態 |
| `GET` | `/api/providers` | Web UI 用の監視データ |
| `POST` | `/v1/chat/completions` | OpenAI 互換チャット中継 |
| `POST` | `/v1/responses` | OpenAI Responses API中継 |
| `POST` | `/v1/embeddings` | Embeddings API中継 |
| `POST` | `/v1/audio/transcriptions` | 音声文字起こし中継（モデルは`x-wentian-model`でも指定可能） |
| `POST` | `/v1/messages` | Anthropic Messages API中継 |
| `POST` | `/v1/rerank` | Reranker API中継 |
| `GET` | `/v1/metrics` | Gateway と Manager のメトリクス |
| `GET` | `/v1/routing/recent` | 直近のルーティング結果 |
| `GET` | `/v1/manager/status` | RAM/VRAM、検出結果、Manager 状態 |
| `GET` | `/v1/manager/models` | モデルごとの安全判定と順位 |
| `POST` | `/v1/manager/unload-plan` | 明示承認前提のアンロード計画（実行はしない） |
| `GET` | `/v1/manager/events` | 永続化されたRouting／Metric／Audit／Circuit履歴 |
| `GET` | `/v1/manager/external-agents` | 組込・手動登録エージェントのリアルタイムCLI状態 |
| `POST` | `/v1/manager/external-agents` | 外部エージェントを手動登録してローカル台帳へ保存 |
| `GET` | `/v1/manager/agent-marketplace` | GitHub人気度上位10候補とローカルCLI生存状態 |
| `POST` | `/v1/manager/agent-install/plan` | 固定Allowlist（許可リスト / Allowlist）の導入計画 |
| `POST` | `/v1/manager/agent-install/approval` | 60秒・1回限りの導入承認Token |
| `POST` | `/v1/manager/agent-install/execute` | 承認済みエージェントのローカル導入 |
| `POST` | `/v1/manager/lifecycle/plan` | モデル状態変更のdry-run計画 |
| `POST` | `/v1/manager/lifecycle/approval` | 1回限りの承認トークン発行 |
| `POST` | `/v1/manager/lifecycle/execute` | 承認済み状態変更（既定無効、現在Ollama対応） |
| `POST` | `/v1/media/comfyui/jobs` | ComfyUIジョブ投入（既定無効） |
| `GET` | `/v1/media/comfyui/jobs/:id` | ComfyUIジョブ状態 |

## 起動

### 実行環境と作業フォルダー

- OS: Windows
- シェル: PowerShell 7（Windows PowerShell でも実行可能）
- 確認済みランタイム: Node.js `v24.16.0`、npm `12.0.2`
- プロジェクトフォルダー: `C:\workspace\wentian-gateway`

以下のコマンドは、最初に任意のフォルダーからプロジェクトフォルダーへ移動して実行します。

```powershell
# 実行環境: Windows PowerShell / PowerShell 7
# 実行フォルダー: 任意
Set-Location -LiteralPath 'C:\workspace\wentian-gateway'

# 実行フォルダー: C:\workspace\wentian-gateway
npm install
npm run dev
```

デフォルトの Web UI は `http://127.0.0.1:8787/` です。LAN/WAN へ公開する場合は `WENTIAN_API_KEY` と CORS 設定を必ず構成してください。

`npm run dev` はフォアグラウンドでGatewayを起動します。停止する場合は、同じPowerShell画面で `Ctrl+C` を押してください。

### Wentian CLI

```powershell
npm run wentian -- server --port 8787 --hostname 127.0.0.1
npm run wentian -- daemon start --port auto
npm run wentian -- daemon status
npm run wentian -- daemon logs
npm run wentian -- agent --server http://127.0.0.1:8787
npm run wentian -- agent --web "最新情報を検索して"
npm run wentian -- agent --verbose "詳細な中間処理を表示して回答して"
wentian confluence login
wentian agent "https://confluence.example.com/pages/viewpage.action?pageId=12345 の内容を確認して"
npm run wentian -- daemon stop
```

`server` はフォアグラウンド起動、`daemon` はPID・ポート・ログを `.wentian/runtime/` で管理する常駐起動です。`agent` は天気をOpen-Meteo、為替をFrankfurterで自動検索し、一般検索は `--web` で明示できます。為替は最新営業日の参照レートで、リアルタイム取引価格ではありません。PowerShell版は `pwsh -File scripts/wentian.ps1`、Python版は `python scripts/wentian.py` から同じサブコマンドを利用できます。

対話中の複数行入力は `:multi`（全角 `：multi` も可）で開始します。`:edit` でドラフト全体をメモ帳から自由編集でき、端末内では `:show`、`:replace <行> <内容>`、`:insert <行> <内容>`、`:delete <行>`、`:undo` を利用できます。`:end` で送信、`:cancel` で破棄します。

## Control Centerダッシュボード

Gateway起動後、ブラウザーで次を開きます。

```text
http://127.0.0.1:8787/
```

画面ではRAM／VRAM、AMD・Intel・NVIDIA GPU検出、プロバイダー状態、local／remote、Safe／Warning／Blocked、モデル能力、Latency／TTFT、Circuit Breaker、ルーティング履歴を確認できます。外部エージェントは組込・手動登録CLIの存在と `--version` を10秒ごとに実測し、リアルタイム状態として表示します。Health Check Cacheは過去証跡として併記し、`Refresh`で即時更新できます。

Agent Marketplace（エージェント市場 / Agent Marketplace）は、公式GitHubリポジトリのStar数を人気度として上位10件を自動登録し、ローカルCLIの `--version` を定期検査します。導入は既定無効で、固定済みのnpm／Winget／uvコマンドだけを、Feature Flag、管理APIキー、計画確認、60秒・1回限り承認、最終確認を満たした場合に実行します。Aider（エイダー / Aider）は依存関係の衝突を避けるため、uvの隔離環境へPython 3.12で導入します。

`WENTIAN_API_KEY`を設定している場合、画面上部のAPI Key欄へ入力します。値はブラウザーのメモリ内だけで使用し、CookieやWeb Storageへ保存しません。

状態変更は画面表示だけでは実行されません。Ollamaのロード／アンロードは、`WENTIAN_ENABLE_STATE_CHANGES=true`、管理APIキー認証、dry-run、60秒以内の1回限り承認トークン、実行後確認、監査記録をすべて満たした場合だけ実行されます。LM Studio／llama.cppは環境ごとに管理APIが異なるため、現時点では安全なAdapter（アダプター）境界までです。

## curl.exeによる簡単な動作確認

- 実行環境: Windows PowerShell / PowerShell 7
- 実行フォルダー: 任意
- 前提: 別のPowerShellで `C:\workspace\wentian-gateway`へ移動し、`npm run dev`を実行しておく
- WindowsではPowerShellの別名との混同を避けるため、`curl`ではなく`curl.exe`と記載しています

### 1. Gatewayの稼働確認

```powershell
curl.exe -sS http://127.0.0.1:8787/health
```

HTTPステータスも表示する場合:

```powershell
curl.exe -sS -i http://127.0.0.1:8787/health
```

### 2. 利用可能なモデル一覧

```powershell
curl.exe -sS http://127.0.0.1:8787/v1/models
```

PowerShellでモデルIDだけを見やすく表示する場合:

```powershell
$Models = curl.exe -sS http://127.0.0.1:8787/v1/models | ConvertFrom-Json
$Models.data | Select-Object -ExpandProperty id
```

### 3. 登録済みプロバイダー一覧

```powershell
curl.exe -sS http://127.0.0.1:8787/v1/providers
```

### 4. 外部サービスだけで自動チャット

```powershell
curl.exe -sS -X POST http://127.0.0.1:8787/v1/chat/completions `
  -H "Content-Type: application/json" `
  --data-raw '{"model":"wentian-auto/remote","messages":[{"role":"user","content":"OKとのみ回答してください"}],"max_tokens":32,"stream":false}'
```

正常時はレスポンスの `wentian` に、実際に選択されたモデルとプロバイダーが入ります。

```json
{
  "wentian": {
    "requested_model": "wentian-auto/remote",
    "resolved_model": "lmstudio/local-model",
    "provider": "lmstudio"
  }
}
```

### 5. ローカルと外部を横断して自動チャット

```powershell
curl.exe -sS -X POST http://127.0.0.1:8787/v1/chat/completions `
  -H "Content-Type: application/json" `
  --data-raw '{"model":"wentian-auto/all","messages":[{"role":"user","content":"1+1を計算してください"}],"max_tokens":64,"stream":false}'
```

### 6. ストリーミング確認

`-N`はcurlの出力バッファリングを無効にします。

```powershell
curl.exe -N -sS -X POST http://127.0.0.1:8787/v1/chat/completions `
  -H "Content-Type: application/json" `
  --data-raw '{"model":"wentian-auto/remote","messages":[{"role":"user","content":"短く自己紹介してください"}],"max_tokens":128,"stream":true}'
```

### 7. 直近のルーティング結果

```powershell
curl.exe -sS http://127.0.0.1:8787/v1/routing/recent
```

### 8. Managerのメモリ・プロバイダー状態

```powershell
curl.exe -sS http://127.0.0.1:8787/v1/manager/status
```

### 9. APIキー認証を有効にした場合

`.env`で `WENTIAN_API_KEY`を設定している場合、`/health`以外のAPIにはBearer認証が必要です。

```powershell
$WentianApiKey = 'ここをWENTIAN_API_KEYと同じ値に置き換える'

curl.exe -sS http://127.0.0.1:8787/v1/models `
  -H "Authorization: Bearer $WentianApiKey"
```

チャット確認:

```powershell
$WentianApiKey = 'ここをWENTIAN_API_KEYと同じ値に置き換える'

curl.exe -sS -X POST http://127.0.0.1:8787/v1/chat/completions `
  -H "Authorization: Bearer $WentianApiKey" `
  -H "Content-Type: application/json" `
  --data-raw '{"model":"wentian-auto/remote","messages":[{"role":"user","content":"OKとのみ回答してください"}],"max_tokens":32}'
```

代表的な判定:

| 結果 | 意味 |
|---|---|
| HTTP `200` | 成功 |
| HTTP `401` | `WENTIAN_API_KEY`不一致またはヘッダー不足 |
| HTTP `404` | 指定モデルIDが見つからない |
| HTTP `503` | 利用可能な候補がない、または全候補が失敗 |

### コマンド別の実行場所

次のコマンドはすべて、WindowsのPowerShellで `C:\workspace\wentian-gateway` に移動してから実行します。

| コマンド | 実行環境 | 実行フォルダー | 用途 |
|---|---|---|---|
| `npm install` | PowerShell、Node.js/npm | `C:\workspace\wentian-gateway` | 依存パッケージをインストール |
| `npm run dev` | PowerShell、Node.js/npm | `C:\workspace\wentian-gateway` | 開発用Gatewayを起動 |
| `npm start` | PowerShell、Node.js/npm | `C:\workspace\wentian-gateway` | Gatewayを起動 |
| `npm run build` | PowerShell、Node.js/npm | `C:\workspace\wentian-gateway` | TypeScriptの型検査 |
| `npm test` | PowerShell、Node.js/npm | `C:\workspace\wentian-gateway` | 単体テストを実行 |

型検査とテストだけを実行する場合:

```powershell
# 実行環境: Windows PowerShell / PowerShell 7
# 実行フォルダー: 任意
Set-Location -LiteralPath 'C:\workspace\wentian-gateway'

# 実行フォルダー: C:\workspace\wentian-gateway
npm run build
npm test
```

## セキュリティ原則

- デフォルトは `127.0.0.1` で待ち受ける。
- LAN/WAN 公開は明示設定と認証を必須にする。
- CORS（オリジン間リソース共有 / Cross-Origin Resource Sharing）は許可オリジンを限定する。
- リモートプロバイダーおよび BYOK（利用者所有キー / Bring Your Own Key）は明示的なオプトインだけで有効にする。
- API キーやプロンプトをログへ平文出力しない。

## ライセンス

このプロジェクトは [MIT License](./LICENSE) で公開しています。

## 現在地

外部エージェントの接続設定もGateway内部で自動保守します。無料モデルの一覧取得と実応答を別々に確認し、無料提供のないエージェントは新ローカルLLMを使います。詳細は[内部接続保守の仕様](docs/agent_connection_maintenance.md)を参照してください。

Phase 1 の中核（集約、明示選択、フォールバック、SSE、エラー透過、認証、CORS、ヘルス、永続履歴）と、Phase 2 の安全な中核（管理画面、資源・ロード状態検出、メモリ推定、Safe/Warning/Blocked、能力スコア、Circuit Breaker、Latency/TTFT、ライフサイクル操作、ComfyUI ジョブAPI）を実装済みです。状態変更と ComfyUI ジョブ実行は既定無効で、機能フラグ、管理APIキー、状態変更時の短期限・1回限り承認を満たした場合だけ実行します。LM Studio／llama.cpp の状態変更は製品・起動方式ごとにAPIが異なるため、共通Adapter境界までを実装し、未対応環境では読み取り専用へ縮退します。
