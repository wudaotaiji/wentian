# Wentian Gateway 利用手順書

## 左メニューの開閉

左メニューは、アイコンと項目名を表示するコンパクト表示に対応しています。下部の「展開」で通常幅に戻し、「折りたたむ」で縮めます。分類を押すと通常幅で配下の項目を開きます。同じタブでは開閉状態を保持します。スマートフォンでは上部の「メニュー」で開閉します。各分類・機能には内容に合った専用アイコンがあり、項目名も常時表示します。[メニュー仕様](unified_navigation.md)を参照してください。

## サイト管理・音声と動画の制作（2026-10-07）

管理者でログインし、「サイト制作 → 作成済みサイト一覧」の各行から編集します。「このサイト削除」は対象名とURLを確認して閉鎖し、完全削除は別の閉鎖済み一覧から行います。[サイト一覧と削除](site_list_lifecycle.md)を参照してください。

音声と動画の制作は `/media-studio`、AI動画生成は `/videos`、保存済みの制作例は `/media-studio#examples` から開きます。読み上げ、BGM・効果音、文字起こし、取り込み、音声編集、動画の速度・音声・字幕を扱います。生成動画は無音または完成音声付きで保存できます。[制作手順・上限・モデルの利用条件](media_production.md)を確認してください。

現在の小型動画モデルはランダム重みの検証用で、実用映像は生成できません。持ち込み動画の編集・音声合成は利用できます。音声3モデルは導入済みですが、別のPCには専用環境と取得設定が必要です。GPUの実機検証は未実施です。

CLI（コマンドライン / Command Line Interface）とWeb会話では制作能力の説明・診断を利用できます。会話から直接制作するツールは未公開です。既に起動したCLIは `/exit` 後に `wentian agent` で起動し直してください。

PC登録・コンテナ配備は `/personal-cloud` を使用します。外部公開のアカウント・ドメイン・TLS準備、Tunnel実接続、複数実PCとGPUの検証は残っています。[Personal Cloud利用手順](personal_cloud_implementation.md)を参照してください。

## CLIによるAgent・Server起動

```powershell
npm run wentian -- server --port 8787 --hostname 127.0.0.1
npm run wentian -- daemon start --port auto
npm run wentian -- daemon status
npm run wentian -- agent --server http://127.0.0.1:8787
npm run wentian -- agent --web "最新情報を検索して"
wentian confluence login
wentian agent "https://confluence.example.com/pages/viewpage.action?pageId=12345 の内容を確認して"
npm run wentian -- daemon stop
```

`server` はフォアグラウンド、`daemon start` はバックグラウンドでGatewayを起動します。`--port auto` は8787～8806を順に検査し、既定のバインド先は `127.0.0.1` です。天気はOpen-Meteo、為替はFrankfurterから自動取得し、一般検索は `agent --web` で明示します。為替は最新営業日の参照レートです。

対話中は `Enter` で送信し、`Shift + Enter`、`Ctrl + Enter`、または `Ctrl + J` で改行します。矢印キー、`Home`、`End`、`Backspace`、`Delete` を使って、送信前の複数行ドラフトを自由に編集できます。入力中の `Ctrl + C` はドラフトを取り消し、空欄での `Ctrl + C` はAgentを終了します。

Codex風のSlash Command（スラッシュコマンド / Slash Command）を利用できます。代表的な操作は次のとおりです。

```text
/status
/update
/training status
/training on
/model
/model wentian-auto/local
/new
/images
/help
/exit
```

入力欄に`/`を打った瞬間にSlash Command候補を一覧表示します。`/`のあと`st`と続けば、`/status`などプレフィックスが一致する候補だけに自動で絞り込まれ、`/`だけのときに比べて表示が短くなります。これにより、Codex風の入力体験を保ったまま、未対応コマンドをAIへ誤送信する事故を防げます。Windows Terminal+OpenTUI経路とレガシーreadline経路のどちらでも同じ挙動です。

`/status`は現在のWorkspace、接続先Server、Daemon、Model、会話件数、添付画像数、外部Agent Ready Poolを表示します。終了には`/exit`を推奨します。従来の`exit`と`quit`も互換性のため残しています。

正式なVersion（バージョン / Version）更新では、最初に`/update`を実行します。未コミット変更がなく更新可能な場合だけ、60秒間有効なTokenと`/update apply <TOKEN>`が表示されます。表示されたコマンドを実行すると、更新、`npm ci`、型検査、全テスト、Daemon再起動を順番に行います。検証に失敗した場合は更新前Commitと依存関係へRollback（ロールバック / Rollback）し、旧Daemonを復旧します。

現在の作業を消さないため、`git status --short`に変更が表示される状態では更新できません。変更をCommitまたは安全に退避してから、もう一度`/update`を実行してください。

自己LLM学習用の会話例を蓄積する場合は、`/training on`で明示的に有効化します。既定では保存されません。状態と保存件数は`/training status`、停止は`/training off`で確認・操作できます。保存先は`.wentian/training/examples.jsonl`で、秘密値と個人Home Pathを伏字化し、画像本体、Tool生出力、内部思考は除外します。

依頼分類モデルを追加学習する場合は、管理画面の「AI・接続 → 大規模言語モデル学習」（`/model-training`）を開きます。確認済みの正解付き分類例を登録し、学習・評価後に合格モデルを有効化します。会話例の蓄積とは別機能です。分類APIが利用できない間は正常確認済みKilo／OpenCodeへ自動切替します。詳細は[公開機能と制限](feature_scope.md)を参照してください。

送信すると一時的な入力欄は消去され、送信済みの質問が通常の端末履歴へ再表示された後に回答が続きます。これにより、PowerShellのスクロールバックで質問と回答の両方を確認できます。`wentian`だけではヘルプが表示されるため、対話を開始するときは`wentian agent`を実行してください。

同一の対話セッションでは過去の質問と回答を会話履歴として保持します。Agentは現在のワークスペース内に限り、UTF-8テキストファイルの読取り・書込みと非破壊的なPowerShellコマンド実行を利用できます。ワークスペース外へのアクセス、削除・破壊操作、PowerShell経由のファイル書込み、外部通信は拒否されます。ファイルの書込みには専用の`write_file` Tool（ツール / Tool）を使用します。

送信後は質問を`wentian>`付きで端末履歴へ確定し、依頼解析、ファイル読取り、Gateway呼出し、Tool実行を`•`と`└`でリアルタイム表示します。待機中は`• Working (19s • esc to interrupt)`のように経過秒数を同じ行で更新します。Agent応答またはTool実行を待っている間に`Esc`を押すと、進行中のHTTP要求またはコマンドを中断して入力へ戻ります。表示対象は実際の操作と状態であり、モデル内部の非公開Chain of Thought（思考連鎖 / Chain of Thought）は含みません。

Codex CLIと同じTodoパネルも同時に表示します。Planner→画像添付→外部Agent委譲→LLM送信の各段階が `# Todos · Wentian Agent` 見出しの下に `[ ]`、`[•]`、`[✓]`、`[!]` の4状態で展開され、進行中の項目は`[•]`、完了した項目は`[✓]`、失敗した項目は`[!]`へ自動で進みます。外部Agentの実行開始後は、見出しを実担当名と確認できたモデル名へ更新し、builder・tester・verifier・reviewerを個別TODOとして表示します。利用制限や失敗で次候補へ移る場合は、停止したAgent、理由の分類、引継ぎ先を明示します。Todo行は確定情報として積まれ、最終の完了状態を回答本文より先に表示します。

長期作業には`/goal`を使用します。`/goal new <TITLE>`で作成し、`/goal run <ID>`で前景実行、`/goal start <ID>`でバックグラウンド実行します。`/goal list`、`/goal status <ID>`、`/goal stop <ID>`で管理できます。同じ操作は`wentian agent --goal ...`からも利用できます。

外部Agent実行中に`Esc`を押した場合やTimeoutになった場合、WentianはWindowsの対象プロセスツリーを終了し、PIDが消えたことを確認してから次のAgent候補または入力画面へ進みます。CLIに`Process tree termination`が表示され、`verified=stopped`なら停止確認済みです。終了対象PID、試行回数、確認結果はワークスペースの`.wentian/orchestration/runs/<task-id>/manifest.json`にも保存されます。

外部Agentが長時間応答しない場合も、5秒ごとに`Working builder`、Agent名、PID、経過時間、最後の出力からの秒数、受信Bytesを表示します。`External output`が表示されるか、`received`が増えていれば処理は進行中です。PIDとHeartbeatが継続しているが出力がない場合はAgent内部で待機している可能性があり、Builderは180秒、Tester／Verifierは90秒で自動的にTimeoutします。待てない場合は`Esc`で安全に中断できます。

モデルのTool Call対応に依存しない直接操作として、`:read README.md`、`:write docs/note.txt 本文`、`:run Get-ChildItem src`を利用できます。`:write`の本文では`\n`を改行として記述できます。

画像は`Ctrl + Shift + V`または`:paste-image`でクリップボードから、`:image "C:\temp\screen.png"`でファイルから添付します。通常の`Ctrl + V`はテキスト貼り付けのままです。`:images`で確認し、質問を入力すると画像と文章を一緒に送信します。単発実行では`wentian agent --image "C:\temp\screen.png" "画像を説明してください"`を使用します。PNG・JPEG・WebP・GIFに対応し、1枚10 MiB、最大4枚・合計20 MiBです。

端末が修飾キー付きEnterを識別できない場合は、互換機能として `:multi` を使用できます。互換モードでは`:edit` でメモ帳から全文を編集し、`:show`、`:replace <行> <内容>`、`:insert <行> <内容>`、`:delete <行>`、`:undo`、`:end`、`:cancel` を使用します。

## 1. この手順でできること

Windows PC上でWentian Gatewayを起動し、OpenCode、Kilo、`curl.exe`、OpenAI互換クライアントから、ローカルおよび外部LLMへ同じBase URL（ベースURL / Base URL）で接続できます。

## 2. 前提環境

- Windows
- PowerShell 7
- Node.js `v24`系
- npm `12`系
- プロジェクト: `C:\workspace\wentian-gateway`
- 任意: Ollama、LM Studio、llama.cpp、OpenCode、Kilo

バージョンを確認します。

```powershell
node --version
npm --version
opencode --version
kilo --version
```

## 3. 初回セットアップ

```powershell
Set-Location -LiteralPath 'C:\workspace\wentian-gateway'
npm install
Copy-Item -LiteralPath '.env.example' -Destination '.env'
npm run build
npm test
```

`.env`はGit管理外です。LAN/WANへ公開しない場合は、既定の `WENTIAN_HOST=127.0.0.1` を維持します。

## 4. Provider設定

ローカルの既定接続先:

| Provider | URL |
|---|---|
| llama.cpp | `http://127.0.0.1:8080/v1` |
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| ComfyUI | `http://127.0.0.1:8188` |

外部Providerは `providers.json` に登録します。APIキーはファイルへ直接書かず、`apiKeyEnv`で参照します。

```json
{
  "id": "example-remote",
  "name": "Example Remote",
  "kind": "llm",
  "scope": "remote",
  "baseUrl": "https://example.invalid/v1",
  "apiKeyEnv": "EXAMPLE_REMOTE_API_KEY",
  "priority": 100,
  "enabled": true,
  "autoRoute": true,
  "tags": ["remote"]
}
```

秘密情報はPowerShellセッションまたは `.env` に設定します。

```powershell
$env:EXAMPLE_REMOTE_API_KEY = '実際のAPIキーへ置換'
```

## 5. 起動と停止

### Daemonの起動・再起動・確認

通常は次のコマンドでGateway Daemon（ゲートウェイ・デーモン / Gateway Daemon）を起動します。

```powershell
wentian daemon start
wentian daemon status
```

設定変更やプログラム更新後は、次の1コマンドで再起動します。外部AgentのReadiness Manager（待機状態管理 / Readiness Manager）も同時に再起動し、起動直後の生存確認を開始します。

```powershell
wentian daemon restart
wentian daemon status
```

`restart`を使用せず、停止と起動を個別に実行する場合:

```powershell
wentian daemon stop
wentian daemon start
wentian daemon status
```

既定ポート`8787`が使用中の場合は、`8787`～`8806`から空きポートを自動選択します。実際のポートは`status`で確認してください。

```powershell
wentian daemon restart --port auto
wentian daemon status
```

再起動後のGatewayと外部Agent Ready Pool（待機候補群 / Ready Pool）を確認します。

```powershell
curl.exe -sS 'http://127.0.0.1:8787/health'
curl.exe -sS 'http://127.0.0.1:8787/v1/manager/external-agents'
```

即時に外部Agentの再確認を実行する場合だけ、`refresh=true`を指定します。この要求は通常の状態取得より時間がかかります。

```powershell
curl.exe -sS 'http://127.0.0.1:8787/v1/manager/external-agents?refresh=true'
```

`WENTIAN_API_KEY`を設定している場合は、管理APIの確認にBearer（ベアラー / Bearer）認証を付けます。

```powershell
$WentianApiKey = '設定したAPIキー'
curl.exe -sS -H "Authorization: Bearer $WentianApiKey" 'http://127.0.0.1:8787/v1/manager/external-agents'
```

グローバルCLIを登録していない場合は、プロジェクトディレクトリーから実行します。

```powershell
Set-Location -LiteralPath 'C:\workspace\wentian-gateway'
npm run wentian -- daemon restart
npm run wentian -- daemon status
```

Daemonログを確認する場合:

```powershell
wentian daemon logs
```

Gatewayをフォアグラウンドで起動します。

```powershell
Set-Location -LiteralPath 'C:\workspace\wentian-gateway'
npm run dev
```

正常時は `http://127.0.0.1:8787` で待ち受けます。停止は同じPowerShellで `Ctrl+C` です。

別のPowerShellから確認します。

```powershell
curl.exe -sS 'http://127.0.0.1:8787/health'
curl.exe -sS 'http://127.0.0.1:8787/v1/models'
curl.exe -sS 'http://127.0.0.1:8787/v1/providers'
```

## 6. Web Control Center

GatewayをDaemonとして起動すると、外部AgentのReadiness Manager（待機状態管理 / Readiness Manager）もバックグラウンドで開始します。起動直後と既定5分間隔で生存状態を更新し、画像、テキスト、プログラム作成、テスト、検収のReady Poolへ分類します。`wentian agent`は`.wentian/external-agent-readiness.json`の新鮮なSnapshotを利用するため、作業指示のたびに全Agentの生存確認完了を待つ必要はありません。

即時の再確認が必要な場合だけ、`GET /v1/manager/external-agents?refresh=true`を使用します。通常の`GET /v1/manager/external-agents`はバックグラウンドで準備済みのSnapshotを返します。

ブラウザーで次を開きます。

```text
http://127.0.0.1:8787/
```

RAM／VRAM、Provider状態、モデル、安全性、Circuit Breaker、Latency／TTFT、ルーティング履歴に加え、組込・手動登録された外部エージェントのリアルタイム状態を確認できます。APIキー認証を有効にした場合は、画面上部のAPI Key欄へ入力します。値はブラウザーの永続ストレージへ保存されません。

外部エージェント欄は各CLIの存在と `--version` 応答を10秒ごとに実測します。手動登録フォームへID、表示名、CLI名、任意のGitHubリポジトリを入力すると `.wentian/manual-agents.json` に保存されます。任意引数やシェル構文は登録できません。

| 表示 | 意味 |
|---|---|
| 利用可能 | 直近24時間以内に正常な証跡がある |
| 利用候補 | 利用条件があり、実行前確認が必要 |
| 要再確認 | 証跡が24時間より古い、または直近作業が未成功 |
| 利用不可・要設定修正 | 既知の設定・Context Limitなどで利用できない |

APIで確認する場合:

```powershell
curl.exe -sS 'http://127.0.0.1:8787/v1/manager/external-agents'
```

### 人気度上位10候補とリアルタイム生存確認

Agent Marketplaceは公式GitHubリポジトリのStar数を人気度として1時間キャッシュし、上位10件を自動登録します。ローカル導入状態と `--version` 応答は5秒キャッシュで検査され、画面の10秒更新に追従します。

```powershell
curl.exe -sS 'http://127.0.0.1:8787/v1/manager/agent-marketplace?limit=10'
```

自動導入を許可する場合だけ、`.env`へ管理APIキーとFeature Flagを設定してGatewayを再起動します。

```dotenv
WENTIAN_API_KEY=ここを十分長いランダム値へ置換
WENTIAN_ENABLE_AGENT_INSTALL=true
```

画面の「計画確認・導入」は、導入計画、1回限り承認、最終確認の順に進みます。任意のコマンドは受け付けず、ソースコードに登録したnpm、Winget、Pythonの固定コマンドだけを実行します。HermesのようなWSL2推奨ツールや、リモートスクリプトを直接実行する方式は自動導入対象外です。

## 7. OpenCode設定

設定ファイルをバックアップします。

```powershell
$OpenCodeConfig = 'C:\Users\USER\.config\opencode\opencode.jsonc'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath $OpenCodeConfig -Destination "$OpenCodeConfig.before-wentian-$Stamp"
notepad.exe $OpenCodeConfig
```

ルートの `provider` オブジェクトへ追加します。

```jsonc
"wentian": {
  "npm": "@ai-sdk/openai-compatible",
  "name": "Wentian Gateway",
  "options": { "baseURL": "http://127.0.0.1:8787/v1" },
  "models": {
    "wentian-auto/local": { "name": "Wentian Auto Local" },
    "wentian-auto/remote": { "name": "Wentian Auto Remote" },
    "wentian-auto/all": { "name": "Wentian Auto All" }
  }
}
```

確認します。

```powershell
opencode models wentian
opencode run --model 'wentian/wentian-auto/remote' 'OKとのみ回答してください'
```

## 8. Kilo設定

設定ファイルをバックアップします。

```powershell
$KiloConfig = 'C:\Users\USER\.config\kilo\kilo.jsonc'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath $KiloConfig -Destination "$KiloConfig.before-wentian-$Stamp"
notepad.exe $KiloConfig
```

OpenCodeと同じ `wentian` Provider定義をルートの `provider` オブジェクトへ追加し、確認します。

```powershell
kilo config check
kilo models wentian
kilo run --model 'wentian/wentian-auto/remote' 'OKとのみ回答してください'
```

## 9. API利用例

### OpenAI互換クライアントの接続設定

WentianはOpenAI互換API（互換API / Compatible API）を提供します。接続するアプリケーションで次の値を指定します。`--port auto`で起動した場合は、`wentian daemon status`に表示されるポートへ置き換えてください。

| 設定 | 値 |
|---|---|
| ベースURL（Base URL） | `http://127.0.0.1:8787/v1` |
| APIキー（API Key） | Gatewayの`WENTIAN_API_KEY`に設定した値。未設定ならWentian側では認証不要 |
| モデル（Model） | `wentian-auto/all`、`wentian-auto/local`、`wentian-auto/remote`、または`プロバイダーID/モデルID` |

クライアントがAPIキーの入力を必須にしていて、Gateway側にキーを設定していない場合は、プレースホルダー（Placeholder）として`no-key`を指定できます。Gateway側でキーを設定した場合は必ず実際の値を指定してください。上流プロバイダーのAPIキーと、Wentianへ接続するためのキーは別です。上流のキーは第4節の`apiKeyEnv`で設定します。

`127.0.0.1`はクライアントを実行するPC自身です。他のPCやコンテナー（Container）から利用する場合は、その環境から到達できるWentianのホスト名・アドレスと待受設定が必要です。

### モデル指定と対応するAPI

| モデル指定 | 動作 |
|---|---|
| `wentian-auto/all` | ローカル・外部の自動選択対象から選択 |
| `wentian-auto/local` | ローカルの自動選択対象から選択 |
| `wentian-auto/remote` | 外部の自動選択対象から選択 |
| `プロバイダーID/モデルID` | 特定のプロバイダー・モデルを指定。実際のIDは`GET /v1/models`で確認 |

`wentian-auto/free`は非推奨（Deprecated）です。新しい接続設定では上記のモデル指定を使用してください。自動選択には有効なプロバイダーと`autoRoute`の設定が必要です。モデル一覧に自動選択用IDが表示されても、推論できる接続先があることを保証するものではありません。会話要求の成功まで確認してください。

| メソッド・パス | 用途・条件 |
|---|---|
| `GET /v1/models` | モデル一覧 |
| `POST /v1/chat/completions` | 会話。`stream: true`でストリーミング（Streaming / SSE）を要求 |
| `POST /v1/responses` | Responses APIを上流へ転送。上流側の対応が必要 |
| `POST /v1/embeddings` | 埋め込み（Embeddings）を上流へ転送。上流側の対応が必要 |
| `POST /v1/audio/transcriptions` | 音声文字起こし（Audio Transcriptions）を上流へ転送。上流側の対応が必要 |

Responses APIなどの転送経路は、Chat Completionsだけに対応する上流を自動変換するものではありません。モデル指定は対応するプロバイダーを明示し、各APIに合ったリクエスト形式を使用してください。その他の経路として`POST /v1/messages`（Anthropic互換）と`POST /v1/rerank`があります。OpenAIの全API・全機能への互換性を保証するものではありません。

### PowerShellで会話を呼び出す

次の例は日本語をUTF-8で送信します。クライアントのPowerShellで`WENTIAN_API_KEY`を設定している場合だけ認証を付けます。Gatewayの`.env`に設定した値は、別のPowerShellへ自動で読み込まれません。

```powershell
# Gatewayと同じキーを環境変数へ設定している場合だけ、Bearer認証を付けます。
$WentianHeaders = @{}
if ($env:WENTIAN_API_KEY) {
    $WentianHeaders.Authorization = "Bearer $env:WENTIAN_API_KEY"
}

# 接続先が返すモデル一覧を確認します。認証設定は会話と共通です。
$WentianModels = Invoke-RestMethod `
    -Uri "http://127.0.0.1:8787/v1/models" -Headers $WentianHeaders
$WentianModels.data | Select-Object id

# OpenAI互換の会話形式で依頼を組み立て、ストリーミングを使わずに送信します。
$WentianBody = @{
    model = "wentian-auto/all"
    messages = @(
        @{ role = "user"; content = "こんにちは。簡単に自己紹介してください。" }
    )
    max_tokens = 128
    stream = $false
} | ConvertTo-Json -Depth 5

$WentianResult = Invoke-RestMethod `
    -Uri "http://127.0.0.1:8787/v1/chat/completions" `
    -Method Post -Headers $WentianHeaders `
    -ContentType "application/json; charset=utf-8" `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($WentianBody)) `
    -TimeoutSec 120

# 応答本文を表示します。通常のJSON応答には選択結果wentianも付加されます。
$WentianResult.choices[0].message.content
$WentianResult.wentian
```

### Pythonで会話を呼び出す

Python標準ライブラリー（Standard Library）だけで実行できる例です。追加パッケージのインストールは不要です。クライアント側の環境変数`WENTIAN_API_KEY`を任意で使用します。

```python
import json
import os
import urllib.error
import urllib.request

# Gateway側にキーを設定した場合は、同じ値をクライアントの環境変数へ設定します。
headers = {"Content-Type": "application/json"}
if os.getenv("WENTIAN_API_KEY"):
    headers["Authorization"] = f"Bearer {os.environ['WENTIAN_API_KEY']}"

# OpenAI互換の会話リクエストをUTF-8でエンコードします。
body = {
    "model": "wentian-auto/all",
    "messages": [{"role": "user", "content": "こんにちは。簡単に自己紹介してください。"}],
    "max_tokens": 128,
    "stream": False,
}
request = urllib.request.Request(
    "http://127.0.0.1:8787/v1/chat/completions",
    data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
    headers=headers,
    method="POST",
)

# エラー時はHTTPステータスとGatewayの説明を表示し、成功と区別します。
try:
    with urllib.request.urlopen(request, timeout=120) as response:
        result = json.load(response)
except urllib.error.HTTPError as error:
    raise SystemExit(f"HTTP {error.code}: {error.read().decode('utf-8', errors='replace')}")

# 回答本文と、Wentianが選択した接続先の情報を表示します。
print(result["choices"][0]["message"]["content"])
print(result.get("wentian", {}))
```

### curlで簡単に確認する

外部モデルだけを自動選択します。

```powershell
curl.exe -sS -X POST 'http://127.0.0.1:8787/v1/chat/completions' `
  -H 'Content-Type: application/json' `
  --data-raw '{"model":"wentian-auto/remote","messages":[{"role":"user","content":"OKとのみ回答してください"}],"max_tokens":64,"stream":false}'
```

ローカルモデルだけを自動選択する場合は、`model`を `wentian-auto/local` に変更します。両方を候補にする場合は `wentian-auto/all` を指定します。

## 10. APIキー認証

`.env`に十分長いランダム値を設定してGatewayを再起動します。

```dotenv
WENTIAN_API_KEY=ここを十分長いランダム値へ置換
```

認証付き確認:

```powershell
$WentianApiKey = 'WENTIAN_API_KEYと同じ値へ置換'
curl.exe -sS 'http://127.0.0.1:8787/v1/models' `
  -H "Authorization: Bearer $WentianApiKey"
```

OpenCode／Kiloでは `wentian.options.apiKey` に同じ値を設定するか、クライアントが対応する認証ストアまたは環境変数展開を利用します。

通常のAPI呼び出しは`Authorization: Bearer <キー>`で認証します。`x-api-key`も利用できます。Web Control Centerのログインと、外部クライアントのAPIキー設定は別の接続手順です。

API呼び出しが失敗した場合は次を確認します。

| 結果 | 確認事項 |
|---|---|
| HTTP 401 | Gatewayに設定したキーとクライアントのキーが一致しているか |
| HTTP 404 / `model_not_found` | モデルID・プロバイダーIDと、そのプロバイダーの有効設定 |
| HTTP 503 / `no_models`・`all_providers_failed` | 利用可能な候補、上流の認証・稼働状態・利用制限。`/health`とエラー本文を確認 |
| モデル一覧のみ成功 | 一覧取得と推論成功は別。短い会話要求でも疎通を確認 |

## 11. E2E受入試験

Gatewayを起動した状態で、どちらかを実行します。

PowerShell版:

```powershell
Set-Location -LiteralPath 'C:\workspace\wentian-gateway'
pwsh -NoProfile -File '.\scripts\e2e_acceptance.ps1' -ClientTimeoutSeconds 120
```

Python版:

```powershell
Set-Location -LiteralPath 'C:\workspace\wentian-gateway'
python '.\scripts\e2e_acceptance.py'
```

Health、外部・ローカルルーティング、SSE途中切断後の生存、OpenCode、Kiloを確認します。状態変更APIは実行しません。

## 12. トラブルシューティング

### Gatewayへ接続できない

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
curl.exe -sS -i 'http://127.0.0.1:8787/health'
```

### HTTP 503になる

`/health` の `providers` を確認します。少なくとも1つのLLM Providerが `ok: true` である必要があります。

```powershell
$Health = curl.exe -sS 'http://127.0.0.1:8787/health' | ConvertFrom-Json
$Health.providers | Format-Table id,kind,ok,status,latencyMs,error
```

### Kiloが応答しない

```powershell
$KiloLogDirectory = 'C:\Users\USER\.local\share\kilo\log'
$LatestKiloLog = Get-ChildItem -LiteralPath $KiloLogDirectory -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
rg -n -i 'wentian|error|timeout|abort|Cannot connect' $LatestKiloLog.FullName
curl.exe -sS 'http://127.0.0.1:8787/health'
```

KiloがTimeoutした直後にOpenCodeなどの次候補が開始された場合は、その前に次の表示があることを確認してください。

```text
• Process tree termination
  └ pid=<対象PID>, attempts=<試行回数>, verified=stopped
```

`verified=still-running`の場合は、その実行のManifestにある`termination`を確認し、新しい外部Agent作業を開始せず残存PIDを調査してください。PIDだけを根拠に無関係なプロセスを停止せず、ManifestのTask ID、Agent、時刻と照合します。

### 安全な再確認

```powershell
Set-Location -LiteralPath 'C:\workspace\wentian-gateway'
npm run build
npm test
git status --short --branch
```

## 13. MCPサーバー・クライアントの利用

Wentianを外部から利用する場合は、MCPサーバー（Server）の `/mcp` へ接続します。`.env` に `WENTIAN_ENABLE_MCP=true` を設定して再起動してください。タスク・巡回・工程のツール（Tools）、所有者別のタスクリソース（Resources）、計画プロンプト（Prompts）を利用できます。HTTP要求は最初に `initialize`、次に `notifications/initialized` を送信し、受け取ったセッションIDを後続要求へ渡します。通常は対応SDKまたはstdioブリッジ（Bridge）に処理を任せます。

Wentianから外部の資料・開発情報・運用情報を取得する場合は、左メニューの「MCP接続」または `/mcp-connections` を開きます。管理者が接続先と許可ツールを登録し、接続・再確認・使用許可／禁止・資料取得・ツール実行を行います。設定の `env` と `headers` は秘密値そのものではなく、値を保持した環境変数の名前を指定します。

Agent CLIへ自動提供する外部ツールは、管理者が `allowedTools` と `readOnlyTools` の両方へ登録した読み取り専用ツールです。変更操作は管理画面またはCLIで引数を確認し、一回限りの承認を取得して実行します。未許可の操作を、外部サーバーの自己申告から自動許可することはありません。

詳しい設定例・CLI・APIは [MCPクライアント利用ガイド](./MCP_CLIENT_USAGE.md)、外部製品からの接続は [MCPサーバー接続ガイド](./VSCODE_MCP_USAGE.md) を参照してください。MCPはツール接続です。モデル推論のOpenAI互換APIは引き続き `/v1` を使用します。

## 14. 関連資料

自動保守の接続・作業検証は専用領域で既定の権限を使用します。Agent別の期限付き許可を更新する必要はありません。プロジェクト作業は「エージェント」画面の「実行範囲・プロジェクトの設定」から対象ディレクトリーを一度設定します。同じ接続先内のモデル変更では再承認せず、取消まで有効です。「一時停止／再開」と「権限の取消／復元」は別の操作です。[詳しい仕様とAPI](execution_defaults.md)を参照してください。

- [MCPクライアントの用途・接続設定・操作方法](./MCP_CLIENT_USAGE.md)
- [MCPサーバーの接続方法](./VSCODE_MCP_USAGE.md)
- [MCPサーバー・クライアント実装仕様](./MCP_IMPLEMENTATION_SPEC.md)
- [全体アーキテクチャー](./ARCHITECTURE.md)
- [CLI・Agent機能仕様](./CLI_REFERENCE.md)
- [正式仕様](../DOCUMENTATION.md)
- [既定の保守権限・プロジェクト共通実行範囲](execution_defaults.md)
- [Mail Solutionsの現行仕様・操作](./mail_solutions_specification.md)：未分類を開くとAI分類・保存。分類の自由追加・改名と5種類の外観選択に対応。人の修正は任意です。自動取得と全件AI分類は別で、全件のバックグラウンド分類は未対応です。
- [公開機能と制限](feature_scope.md)
