# Wentian Gateway 全体アーキテクチャー

## 2026-10-07の追加コンポーネント

Personal Cloudは端末登録・署名付き通信・コンテナ実行・配置判断を `src/personal-cloud/` に分離します。制作系は `src/video-generation.ts` と `src/media-production.ts` が認証・所有者・永続キュー（Queue）を管理し、専用Pythonワーカー（Worker）がComfyUIなしで生成・FFmpeg編集を実行します。`src/media-model-maintenance.ts` は取得許可と版を保持してモデルを修復します。`src/media-agent-capabilities.ts` はCLI・Web会話へ共通の能力・診断を渡します。[公開機能と制限](feature_scope.md)から詳細仕様と検証範囲を参照できます。

Mail Solutionsは `src/mail-operations.ts` が業務・分類保存、`src/mail-taxonomy.ts` が自由分類設定、`src/mail-ai.ts` と `scripts/propose-mail-categories.py` が基底モデル接続を担当します。未分類を開くとAIが先に判断・保存し、人の修正は任意です。主保存先はSQLiteと原文ファイル、分類設定は学習ディレクトリの `taxonomy.json`、PostgreSQLとMinIO/S3は任意です。既定はWentianの有効学習設定の基底モデルを再利用し、外部エージェントへ委任しません。[Mail Solutions現行仕様](mail_solutions_specification.md)にAPI・制約・検証範囲を記載します。

## 1. 目的

Wentian Gatewayは、OpenAI互換クライアントの接続先を一本化し、ローカルおよび外部のLLM（大規模言語モデル / Large Language Model）へ安全にルーティングするローカルファーストのGateway（ゲートウェイ / Gateway）です。Manager（マネージャー / Manager）は、RAM／VRAM、モデル能力、ロード状態、障害状態を観測し、自動選択と安全なライフサイクル操作を支援します。

## 2. システム全体構成

```mermaid
flowchart LR
    CLI["wentian CLI"] --> Agent["agent: 対話実行"]
    CLI --> Server["server: Gateway起動"]
    CLI --> Daemon["daemon: 常駐管理"]
    Daemon --> Server
    Agent --> Server
    Server --> Control["Control Center"]
    Server --> Providers["LLM / External Agents"]
    Agent --> Confluence["認証済みConfluence / Playwright"]
```

```mermaid
flowchart TB
    subgraph Clients["クライアント層"]
        OC["OpenCode"]
        Kilo["Kilo"]
        SDK["OpenAI互換SDK / curl"]
        Browser["Webブラウザー"]
    end

    subgraph Gateway["Wentian Gateway / Fastify"]
        Auth["APIキー認証・CORS"]
        API["OpenAI互換API"]
        Router["明示選択・Auto Router"]
        Manager["Local AI Manager"]
        Safety["Memory Guard・能力評価"]
        Circuit["Circuit Breaker・Rate Limit"]
        Metrics["Latency・TTFT・Routing履歴"]
        Lifecycle["Lifecycle Controller"]
        Dashboard["Manager Dashboard"]
        Agents["External Agent Registry"]
        Marketplace["Popularity Discovery・Live Probe"]
        Installer["Approved Local Installer"]
        Store["JSONL Event Store"]
    end

    subgraph Local["ローカルバックエンド"]
        Llama["llama.cpp"]
        Ollama["Ollama"]
        LMStudio["LM Studio"]
        ComfyUI["ComfyUI"]
    end

    subgraph Remote["外部OpenAI互換サービス"]
        Precision["lmstudio"]
        Qwen38["lmstudio"]
        Qwen36["ollama"]
        Extra["providers.json追加先"]
    end

    OC --> Auth
    Kilo --> Auth
    SDK --> Auth
    Browser --> Dashboard
    Auth --> API
    API --> Router
    Router --> Manager
    Manager --> Safety
    Router --> Circuit
    Router --> Local
    Router --> Remote
    Manager --> Metrics
    Lifecycle --> Ollama
    API --> Lifecycle
    API --> ComfyUI
    Router --> Store
    Lifecycle --> Store
    Dashboard --> Manager
    Dashboard --> Metrics
    Dashboard --> Agents
    Dashboard --> Marketplace
    Marketplace --> GitHub["GitHub Repository API"]
    Marketplace --> LocalCli["ローカルCLI --version"]
    Dashboard --> Installer
    Installer --> PackageManagers["npm / Winget / Python"]
    AgentCache[".agent_orchestration / Health Check Cache"] --> Agents
```

## 3. コンポーネント責務

| コンポーネント | 実装 | 主な責務 |
|---|---|---|
| APIサーバー | `src/server.ts` | Fastify起動、認証、CORS、API公開、ルーティング統合 |
| 設定 | `src/config.ts` | `providers.json`解析、URL安全性、環境変数スキーマ検証 |
| Proxy | `src/proxy.ts` | 許可パス、HTTPエラー分類、SSE中継、切断・タイムアウト伝播 |
| Manager | `src/manager.ts` | RAM／VRAM観測、モデル検出、必要メモリ推定、安全性と能力順位付け |
| Lifecycle | `src/lifecycle.ts` | dry-run、短期限承認、Ollama状態変更、実行後確認、ComfyUIジョブ |
| Storage | `src/storage.ts` | Routing／Metric／Audit／CircuitイベントのサニタイズとJSONL永続化 |
| Dashboard | `src/dashboard.ts` | Control Centerとしてプロバイダー、モデル、資源、外部エージェント、履歴、管理操作を表示 |
| External Agent Registry | `src/external-agents.ts` / `src/manual-agent-registry.ts` | CLIリアルタイム検査、組込・手動登録、ローカル台帳の安全な永続化 |
| Terminal Draft Editor | `src/terminal-draft.ts` | TUI複数行入力、カーソル移動、Shift/Ctrl+Enter改行、端末互換フォールバック |
| Image Input | `src/image-input.ts` | ファイル・Windowsクリップボード画像、形式・容量検査、Data URL化、モデル単位のVisionルーティング要求 |
| Agent Marketplace | `src/agent-marketplace.ts` | GitHub Star人気度、上位10候補、ローカルCLI生存確認、承認付き導入 |

## 4. チャット要求の流れ

```mermaid
sequenceDiagram
    participant C as Client
    participant G as Gateway
    participant M as Manager
    participant P as Provider
    participant S as Event Store

    C->>G: POST /v1/chat/completions
    G->>G: APIキー・CORS・入力確認
    G->>P: GET /v1/models
    P-->>G: 利用可能モデル
    G->>M: RAM/VRAM・能力・ロード状態で順位付け
    M-->>G: Safeな候補順
    loop 成功または候補枯渇まで
        G->>P: Chat要求
        alt 成功
            P-->>G: JSONまたはSSE
            G->>S: Routing/Metric記録
            G-->>C: 応答とx-wentian-*ヘッダー
        else フォールバック可能な障害
            G->>G: Circuit Breaker更新
        else 透過対象のクライアントエラー
            P-->>C: HTTP状態・Content-Type・本文を透過
        end
    end
```

仮想モデルのスコープは次のとおりです。

| モデルID | 候補範囲 |
|---|---|
| `wentian-auto/local` | ローカルLLMのみ |
| `wentian-auto/remote` | 外部LLMのみ |
| `wentian-auto/all` | ローカルと外部 |
| `provider/model-id` | 指定プロバイダーの指定モデル |

## 5. Managerの安全判定

```mermaid
flowchart LR
    Discover["モデルとロード状態の検出"] --> Estimate["必要RAM/VRAM推定"]
    Observe["実機RAM/VRAM観測"] --> Evaluate["安全性評価"]
    Estimate --> Evaluate
    Capability["能力・Context・Task要件"] --> Rank["候補順位付け"]
    Evaluate --> Rank
    Circuit["Circuit状態・Rate Limit"] --> Rank
    Rank --> Safe["Safe"]
    Rank --> Warning["Warning"]
    Rank --> Blocked["Blockedを除外"]
```

`Unknown`、資源不足、未対応Adapter（アダプター / Adapter）は安全側へ倒し、状態変更せず読み取り専用監視へ縮退します。

## 6. 状態変更の安全境界

```mermaid
sequenceDiagram
    participant A as Administrator
    participant G as Gateway
    participant L as Lifecycle Controller
    participant O as Ollama Adapter
    participant S as Audit Store

    A->>G: lifecycle/plan（dry-run）
    G->>L: 実行しない計画
    L-->>A: 対象・操作内容
    A->>G: lifecycle/approval + 管理APIキー
    G-->>A: 60秒・1回限りToken
    A->>G: lifecycle/execute + Token
    G->>L: Feature Flag・認証・Token確認
    L->>O: load / unload
    O-->>L: 実行結果
    L->>O: 状態再確認
    L->>S: Audit記録
    L-->>A: executed / verified
```

状態変更とComfyUIジョブは既定無効です。`WENTIAN_ENABLE_STATE_CHANGES=true` または `WENTIAN_ENABLE_COMFYUI_JOBS=true` に加え、`WENTIAN_API_KEY`による管理認証が必要です。

## 7. データと秘密情報

- `providers.json`: Providerメタデータ。秘密鍵は書かず、`apiKeyEnv`で環境変数名を参照します。
- `.env`: ローカル秘密情報を含み得るためGit管理外です。
- `.wentian/events.jsonl`: サニタイズ済みイベント。Prompt（プロンプト / Prompt）、Token、Authorizationなどは禁止キーとして除外します。
- `.e2e/`: E2Eログ。Git管理外です。

## 8. 現在の対応範囲

- OpenAI Chat Completions、Responses、Embeddings、Audio Transcriptions
- Anthropic Messages、Rerank
- JSONおよびSSE透過中継、クライアント切断伝播
- Auto Local／Remote／All、フォールバック、セッションAffinity（アフィニティ / Affinity）
- RAM、NVIDIA／AMD／Intel VRAM、モデル安全性、Circuit Breaker、Latency／TTFT
- Ollamaの承認付き状態変更、ComfyUIジョブ境界
- LM Studio／llama.cppの状態変更は共通Adapter境界までで、未対応環境では読み取り専用です。

## 9. Agent入力解析の現状と目標設計

### 9.1 現在の処理方式

現在の`wentian agent`は、通常のユーザー入力を最初にPlanner AI（計画AI / Planner AI）へ渡すPlanner中心方式です。TypeScriptのルールベース（Rule-based）処理は、Plannerより先に意味を決める主経路ではなく、構造化出力の検証、安全境界、Planner異常時のフォールバックを担当します。

```mermaid
flowchart TD
    Input["ユーザーの生入力"] --> Planner["Planner AI"]
    Planner --> Plan["Version付き構造化実行計画"]
    Plan --> Guard{"Schema・権限・安全性を検証"}
    Planner -->|無応答・不正JSON| Rules["決定論的分類へ縮退"]
    Rules --> Guard
    Guard -->|制作・修正| External["External Agent Orchestrator"]
    Guard -->|通常応答・専用取得| Tool["Tool / Gateway Router"]
    External --> Result["成果物・検収結果"]
    Tool --> Result
```

Plannerは意図、必要能力、添付候補、Tool候補、外部委譲を自然言語から構造化します。パスの実在確認、秘密情報保護、書込み範囲、コマンド許可、モデル能力の強制は決定論的コードが担当します。これにより、新しい言い回しへの対応をPlannerへ寄せながら、AIの判断だけでファイル操作やコマンド実行を許可しない構成にしています。

### 9.2 Planner中心方式の目標

入力の意味理解をPlanner AIへ任せ、構造化された実行計画を決定論的コードが検証・実行する基盤は実装済みです。今後はPlanner Schema、能力照合、受入判定の精度と対応Runnerを拡充します。

`WENTIAN_PLANNER_MODEL`または`agent-selection.json`でPlannerを指定し、既定値は`wentian-auto/all`です。有効化済み自己学習モデルを優先し、APIが不通の場合はSystem Promptを保持して正常確認済みKilo／OpenCodeで分類を代替します。各出力に同じSchema検証を適用します。認証・利用制限・予算エラーは外部接続で回避せず、APIの不正JSONは同じモデルで修正を試みます。全経路失敗時は固定キーワードから書込み権限を推測せず安全停止します。詳細は[公開機能と制限](feature_scope.md)と[公開機能と制限](feature_scope.md)を参照してください。

```mermaid
flowchart TD
    Input["ユーザーの生入力"] --> Planner["Planner AI"]
    Planner --> Plan["構造化実行計画"]
    Plan --> Validate{"安全性・権限・実在性を検証"}
    Validate -->|拒否| Explain["拒否理由を表示"]
    Validate -->|許可| Executor["Tool Executor"]
    Executor --> Router["Capability-based Model Router"]
    Router --> Text["Text Model"]
    Router --> Vision["Vision Model"]
    Router --> Coding["Coding Model"]
    Router --> Web["Web Tool / Model"]
    Text --> Answer["最終回答"]
    Vision --> Answer
    Coding --> Answer
    Web --> Answer
```

Plannerの出力例を次に示します。実際のスキーマは実装時にVersion（バージョン / Version）を付け、JSON Schemaで検証します。

```json
{
  "language": "ja",
  "intent": "analyze_image",
  "text": "何の画像ですか教えて",
  "attachments": [
    {
      "type": "local_file",
      "path": "C:\\Users\\user\\screen.png"
    }
  ],
  "required_capabilities": ["vision"],
  "tools": ["read_image"],
  "response_language": "ja"
}
```

### 9.3 外部エージェント自動オーケストレーション

Plannerが制作・実装・修正、独立して並行化できる作業、または外部エージェントによるレビューが有効な作業と判断した場合は、External Agent Orchestrator（外部エージェント・オーケストレーター / External Agent Orchestrator）へ構造化タスクを渡します。制作依頼ではユーザーが外部委譲を明記しなくても、次の外部Agent優先経路を選択します。

Gateway Daemon（ゲートウェイ・デーモン / Gateway Daemon）は要求がない間もExternal Agent Readiness Manager（外部エージェント待機管理 / External Agent Readiness Manager）を動かします。起動直後と既定5分間隔で生存確認し、正常なAgentを`image`、`text`、`coding`、`testing`、`verification`へ分類します。結果は`.wentian/external-agent-readiness.json`へAtomicに保存されるため、別プロセスの`wentian agent`も要求到着時にReady Poolを即時利用できます。

```mermaid
flowchart LR
    Timer["Daemon起動・定期Timer"] --> Probe["Agent CLI生存確認"]
    Probe --> Classify["能力分類"]
    Classify --> Image["image Pool"]
    Classify --> Text["text Pool"]
    Classify --> Coding["coding Pool"]
    Classify --> Testing["testing Pool"]
    Classify --> Verification["verification Pool"]
    Image --> Cache["Atomic Ready Snapshot"]
    Text --> Cache
    Coding --> Cache
    Testing --> Cache
    Verification --> Cache
    Request["wentian agent作業指示"] --> Planner["Planner AI"]
    Planner --> Cache
    Cache --> Dispatch["待機済みAgentへ即時Dispatch"]
```

```mermaid
sequenceDiagram
    participant U as User
    participant P as Planner AI
    participant O as Orchestrator
    participant B as Builder候補群
    participant T as Tester候補群
    participant V as Verifier候補群
    participant L as 内部LLM
    U->>P: 生入力
    P->>O: 構造化計画・受入基準
    loop Builder候補を順次試行
        O->>B: Workspace限定の制作依頼
        B-->>O: 成果物または失敗
    end
    alt Builder完了
        O->>T: 別Agentへ読取り専用試験
        T-->>O: テスト結果
        O->>V: 別Agentへ最終検収
        V-->>O: 合格・不合格
    else Builder候補全滅
        O->>L: 最終フォールバック
    end
    alt TesterまたはVerifier工程を外部Agentで完了不能
        O->>L: 最終フォールバック
    else 全工程合格
        O-->>U: 成果物・検収結果
    end
```

同一役割の候補は順番に再試行し、候補を使い切る前に内部LLMへ切り替えません。制作工程は書込み競合を避けるため直列で進め、独立した読み取り専用レビューだけを最大3件まで並列実行できます。

Timeoutまたは`Esc`による中断時は、Windowsのプロセスツリー終了処理の完了と対象PIDの消滅確認を待ちます。残存時は最大2回まで終了を試行し、その確認結果をCLIとManifestへ記録してから次候補へ進みます。外部のBuilder、Tester、Verifierがすべて完了した場合は内部LLMを呼ばず、外部Agentの成果物と検収結果を最終結果とします。

プロセス管理の状態遷移は次のとおりです。

```mermaid
stateDiagram-v2
    [*] --> Running
    Running --> Completed: 正常終了
    Running --> Terminating: Timeout / Esc
    Terminating --> Verifying: taskkill /T /F完了
    Verifying --> Stopped: PID消滅
    Verifying --> Retrying: PID残存かつ初回
    Retrying --> Verifying: 2回目の終了処理
    Verifying --> ResidualDetected: 2回後もPID残存
    Stopped --> NextCandidate: 役割未完了
    Stopped --> [*]: Escによる要求中断
    Completed --> [*]
    ResidualDetected --> Recorded: CLI・Manifestへ異常記録
    Recorded --> [*]
```

```mermaid
flowchart TB
    User["ユーザー入力"] --> Planner["Planner AI"]
    Planner --> Plan["Version付き構造化実行計画"]
    Plan --> Policy{"Policy・権限・秘密情報検証"}
    Policy -->|拒否| Reject["拒否理由と必要な承認を表示"]
    Policy -->|許可| Decide{"外部委譲が必要か"}
    Decide -->|No| Local["内部Model / Tool Executor"]
    Decide -->|Yes| Decompose["Task Decomposer<br/>独立タスクへ分割"]

    subgraph Orchestrator["External Agent Orchestrator"]
        Decompose --> Cache["Health Check Cache読込み<br/>summary.json・report.md・raw_logs・manifest"]
        Cache --> Fresh{"正常確認が24時間以内か"}
        Fresh -->|Yes| Capability["能力・実績・コスト・書込み可否で候補化"]
        Fresh -->|No| Probe["必要な候補だけ軽量Health Check"]
        Probe --> Capability
        Capability --> DryRun["最初の小さい読取り専用タスク"]
        DryRun --> Select{"実作業可能か"}
        Select -->|No| Replan["別Agent選択または再計画"]
        Select -->|Yes| Dispatch["Task Dispatcher<br/>禁止操作・停止条件・書込み範囲・報告先を付与"]
        Dispatch --> Runners["Agent-specific Runners"]
        Runners --> Goose["goose"]
        Runners --> Crush["crush"]
        Runners --> Kilo["Kilo"]
        Runners --> OpenCode["OpenCode"]
        Runners --> Hermes["Hermes"]
        Runners --> Claude["Claude"]
        Runners --> Cline["Cline"]
        Runners --> OpenClaw["OpenClaw"]
        Goose --> Collect["Result Collector"]
        Crush --> Collect
        Kilo --> Collect
        OpenCode --> Collect
        Hermes --> Collect
        Claude --> Collect
        Cline --> Collect
        OpenClaw --> Collect
        Collect --> Ledger["Manifest・raw_logs・summary.json・report.md更新"]
    end

    Ledger --> Verify["Wentian/Codex Verifier<br/>実ファイル・ログ・環境で検収"]
    Verify --> Valid{"受入基準を満たすか"}
    Valid -->|Yes| Merge["結果統合・最終回答"]
    Valid -->|No| Retry{"再投入可能か"}
    Retry -->|Yes| Replan
    Retry -->|No| Fallback["内部Agentが直接継続<br/>失敗理由と再投入条件を記録"]
    Local --> Merge
    Fallback --> Merge
```

自動選定ではCLIが存在するだけで実作業可能とは判定しません。Health Check（生存確認 / Health Check）と、対象ファイルの先頭行読取りなどの小さい読み取り専用タスクを分けて評価します。直近24時間以内の正常な証跡は再利用し、PC再起動、CLI・モデル・設定・認証情報の変更、直近失敗、24時間超過、重要または長時間作業の場合だけ必要な候補を再確認します。

PlannerからOrchestratorへ渡すタスクには、少なくとも次を含めます。

| フィールド | 内容 |
|---|---|
| `task_id` / `parent_task_id` | 親子関係を追跡できる一意なタスクID |
| `objective` | エージェントが達成すべき具体的な目的 |
| `required_capabilities` | 読取り、編集、Terminal、Web、Browser、レビューなどの必要能力 |
| `allowed_write_paths` | 書込みを許可するファイルまたはディレクトリー |
| `forbidden_operations` | delete、drop、patch、scale、外部送信などの禁止操作 |
| `stop_conditions` | Timeout、同一エラー回数、権限不足などの停止条件 |
| `acceptance_criteria` | 成果を採用するためのテストと確認条件 |
| `report_path` | 完全な実行コマンド、結果、未解決事項を保存する場所 |

複数エージェントへ並行投入するのは、タスク間に書込み競合がなく、成果を独立して検収できる場合に限定します。同一ファイルを複数エージェントが編集する場合は、原則として一方を実装担当、他方を読み取り専用レビュー担当にします。外部エージェントの報告は自動採用せず、Verifierが実ファイル、実行ログ、テスト結果、環境状態を確認してから統合します。

#### 現在の実装状態

前掲の全体図には将来対応Runnerも含みます。現在実装されている範囲と未実装範囲は次のとおりです。

| 機能 | 状態 |
|---|---|
| 外部エージェント台帳、CLI存在・Versionのリアルタイム確認 | 実装済み |
| `.agent_orchestration/summary.json`の証跡読込みとControl Center表示 | 実装済み |
| 承認付き外部エージェント導入API | 実装済み・既定無効 |
| AGENTS.mdに基づく24時間キャッシュ、軽量確認、禁止操作の運用 | 手順として運用中 |
| Plannerによる入力分類、Task Schema生成、Agent能力の自動照合 | 実装済み |
| Agent別Runnerによる自動編成 | goose、crush、Kilo、OpenCodeに対応。制作はbuilder→tester→verifierを順次実行し、独立レビューは最大3件を並列実行 |
| Manifest更新と成果統合 | 実装済み |
| 成果物の自動受入テスト、失敗理由に応じた再投入 | 段階実装中 |

制作依頼ではPlannerが外部委譲を自動設定し、書込み可能なbuilderを1つ、読み取り専用testerとverifierを別Agentへ割り当てます。内部LLMのTool実行は、外部Agent編成不能または全段階を完了できなかった場合だけフォールバックとして使用します。`WENTIAN_ENABLE_EXTERNAL_ORCHESTRATION=false`を設定するとRunnerを停止し、計画とManifestだけを生成できます。AGENTS.md固有の詳細ルールと既存`.agent_orchestration`スクリプトは引き続き上位Policyとして適用します。

### 9.4 AIと決定論的コードの責務分離

AIに入力解釈を任せても、ファイルアクセスやコマンド実行を無検証で許可してはいけません。責務は次のように分離します。

| 判断・処理 | 担当 |
|---|---|
| 入力内のパス、質問、意図、希望言語の候補抽出 | Planner AI |
| 必要な能力とTool候補の作成 | Planner AI |
| Providerと実モデルの候補順位付け | Gateway Router |
| パスの実在、形式、サイズ、許可範囲の検証 | 決定論的な安全検証コード |
| コマンドの許可、Timeout、破壊操作の拒否 | 決定論的な安全検証コード |
| 秘密情報、外部送信、認証、承認の検証 | 決定論的な安全検証コード |
| Tool実行結果を使った最終回答 | 選択された実行モデル |

ローカルファイルのパス文字列をPlannerが画像候補と判断しても、AI自身がWindowsファイルを直接読めるわけではありません。Wentianがパスを検証してファイルを読み込み、安全な形式へ変換した後、Vision対応モデルへ渡します。

### 9.5 継続移行方針

Plannerは主経路へ移行済みです。既存ルールは撤去せず、安全ガードと障害時の縮退経路として維持します。以後は次の項目を段階的に強化します。

1. Planner用のVersion付き構造化出力Schemaを拡張し、互換性を維持する。
2. パス検証、Tool権限、秘密情報、外部送信制御をPolicy層へ集約する。
3. Hermes、Claude、Cline、OpenClawを含むAgent別Runnerを、安全性検証後に追加する。
4. 成果物種別ごとの自動受入テストと、失敗理由に応じた再投入を拡充する。
5. Manifest、raw logs、成果物、検収結果を単一Task IDで追跡する範囲を広げる。
6. 判断理由、選択Tool、要求能力、Agent選択をCLIへリアルタイム表示し続ける。

この設計により、新しい自然言語表現への適応性を高めながら、AIの誤判断による任意ファイル読取りや危険なコマンド実行を防止します。
