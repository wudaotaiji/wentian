# AI最小内核・分散Cloud・グループA2A 初期実装台帳

作成日：2026-10-17（日本時間）

状態：初期実装。仕様全体、公共Cloud、WTC、Kubernetes・VM統合の完成報告ではない。

## 1. 実装した範囲

| モジュール | 実装 |
|---|---|
| 最小内核 | `NodeSupervisor`が機器観測、AI構成判断、依存・許可・資源検証、Pluginライフサイクル、ヘルス確認、正常構成の保存・復元を担当 |
| 軽量な起動入口 | `wentian node-core --config ...` は全機能CLIやBunを経由せずNode.jsで起動。HTTP・分散CloudはAIが選択した時だけ遅延読込 |
| AI保守 | 利用者設定のOpenAI互換エンドポイント・モデルへ定期的に判断を依頼。不明時は直前構成を維持。AIの内核再起動要求は最大3回まで親プロセスが再起動 |
| Plugin拡張 | 許可済みローカルModuleのカタログへ機能を追加可能。既存Plugin Kernelにも実行アダプター・AI受入判断・Cloudファクトリーを別サービスとして登録 |
| ノード識別 | Ed25519、公開鍵由来のノードID、相手鍵の固定。Windows秘密鍵はDPAPI、他OSは専用領域とファイル権限 |
| 永続状態 | ノード固有のSQLite、即時トランザクション、同一台帳の二重起動防止、再送・予約・注文・A2A状態の保存 |
| 直接取引 | 署名付きサービス確認、AI受入判断、予約、明示合意、実行、状態照合、予約取消。受付は既定で無効 |
| A2A | 利用者の目的からAIが発話・サービス確認・見積り・合意・結果確認を選択。相手のAIが相談と受入を判断。成功署名の根拠なしでは完了不可 |
| 人間が確認するグループ | ノード対ごとの同一IDグループを双方に保存。発話・契約・署名要求応答・実行結果を既存Workbenchグループに表示。保存不能なら新規通信を停止 |
| 初期実行サービス | 明示されたテキストのSHA-256計算。副作用のない経路で実行・署名・照合を検証するための初期アダプター |

SHA-256計算、署名、形式検証は決定的なプロトコル・計算処理である。利用者の意図、プラグイン選択、サービス適合性、会話・次の操作を固定キーワードで判断しない。既存全機能Gatewayも利用できるが、各ノードの最小構成を目的にする場合は専用入口を使う。

## 2. ファイルと交換境界

| ファイル | 責任 |
|---|---|
| `src/cloud-federation/contracts.ts` | 構造化契約と検証 |
| `identity.ts`／`repository.ts`／`transport.ts` | 鍵、ローカル台帳、署名通信 |
| `adapters.ts`／`ai-review.ts` | 実行サービスとAI判断。互いに分離 |
| `service.ts`／`group-journal.ts` | 注文・A2A制御と必須グループ記録 |
| `plugin.ts` | 既存Plugin Kernelのサービス登録と差替え |
| `node-supervisor.ts`／`node-catalog.ts` | 最小内核のAI保守と許可済み候補 |
| `node-entry.ts` | 最小内核専用起動、ローカルHTTP Plugin |
| `routes.ts`／`ui.ts` | 管理者APIと既存Gateway用画面 |

外部Pluginは実行アダプターやAI判断サービスを差し替えられる。任意のModuleをAIがダウンロード・インストールする仕組みは有効にしていない。

## 3. 最小内核の起動設定

設定JSONの例。接続先・モデル・保存先・目的は利用者が置き換える。`groupWorkspace`は、人間が閲覧するWorkbenchの `WENTIAN_TASK_WORKSPACE` と同じ作業領域にする。設定ファイルからの相対パスとして解決する。

```json
{
  "directory": "./.wentian/native-node",
  "groupWorkspace": ".",
  "objective": "このPCを軽量な独立Wentianとして運用し、他ノードとのA2Aを利用する",
  "maintenanceIntervalMs": 60000,
  "reserveMemoryBytes": 2147483648,
  "reserveDiskBytes": 10737418240,
  "ai": {
    "endpoint": "https://ai-gateway.example",
    "model": "利用者のモデルID",
    "apiKeyEnv": "WENTIAN_NODE_AI_KEY"
  },
  "cloud": {
    "host": "127.0.0.1",
    "port": 8788,
    "adminTokenEnv": "WENTIAN_NODE_ADMIN_TOKEN"
  },
  "plugins": []
}
```

`ai.endpoint`は `/v1` を含まないルートURL。モデル・認証値を設定し、管理トークンは24文字以上の推測困難な値を環境変数へ渡す。秘密値を設定JSONやGitへ保存しない。認証不要の利用者管理AIサーバーなら `apiKeyEnv` を省略できる。AI保守とA2Aは設定したAIの利用量を消費する。

```text
node bin/wentian.js node-core --config 利用者の設定JSON
node bin/wentian.js node-core --config 利用者の設定JSON --once
```

`--once`は構成とヘルスを一度確認してから終了する。常駐はプロセスが生きている間の定期保守であり、PCの電源断・スリープ・サインアウトを越える運用を保証しない。OSサービスへの登録は今回実施していない。

最小内核のHTTPは指定した数値ループバックだけで待ち受ける。遠隔参加には利用者管理のHTTPS経路が必要。接続先URLのリダイレクトは許可しない。各ノードで管理APIのBearer認証を行い、相手ノード署名へ管理権限を与えない。

## 4. Pluginの追加方法

設定フォルダー配下に信頼できるModuleを置き、`plugins`へ `./plugins/example.mjs` のような相対パスを指定する。Moduleのdefault exportは次の契約を満たす。

```typescript
interface ManagedPlugin {
  definition: WentianPluginDefinition;
  description: string;
  memoryBudgetBytes: number;
  diskBudgetBytes: number;
  health(kernel: WentianPluginKernel): Promise<{ healthy: boolean; detail: string }>;
}
```

AIは説明・機器観測・目的から候補を選ぶ。ID・依存と予算を内核が検証する。setupで必要な機能を起動し、返した終了関数で終了する。Moduleのトップレベルに起動処理を置かず、候補登録だけでサービスを開始しない。許可外フォルダーや未許可パッケージ名は拒否する。Module自体は利用者が信頼するコードであり、敵対的なPluginを隔離するサンドボックスではない。

## 5. 全機能GatewayとWorkbenchでの利用

標準Plugin Profileに `core.cloud-adapters`、`core.cloud-ai-review`、`core.cloud-federation` を追加した。最小Profileは変更していない。通常Gateway側は次の利用者設定を使う。

- `WENTIAN_FEDERATION_HOME`：ノード台帳の保存先。省略時はインストール先の `.wentian/federation`。
- `WENTIAN_FEDERATION_REVIEW_MODEL`：受入判断とA2A用のモデル。未設定時はAI判断を未確認として受付を拒否。
- `WENTIAN_TASK_WORKSPACE`：既存Workbenchと共用するグループ保存領域。

Gateway再起動後、`/personal-cloud`から `/cloud-federation` を開ける。既存のローカル管理者としてログインし、双方で公開識別情報を交換して別経路でノードIDを確認し、相手URLと鍵を承認する。提供側で外部受付を明示的に有効にする。

「AI同士に依頼する（A2A）」へ目的を入力すると、AIが次の通信を選ぶ。相手とのグループは最初の送信前に作成され、`/workbench#groups`で確認できる。通常のグループ議論として相手ノードの代役を動かさない。人間の発言は次のA2A判断の資料になるが、完了した対話が投稿だけで自動再開する仕様ではない。

初期グループは二者のノードと人間の観察・参加を対象とする。三者以上の共同取引、履歴の完全同期、外部A2A標準との相互運用は未実装。共有したタスク本文と結果はグループ閲覧者にも見える。ノードの鍵・AI認証値・管理トークンはグループへ保存しない。

## 6. 主なAPI

管理APIはローカル所有者の認証が必要。ノード間APIだけは相手の署名と登録鍵を検証する。

| API | 内容 |
|---|---|
| `GET /api/cloud-federation` | ローカル状態・公開識別情報・注文・対話状態 |
| `POST /api/cloud-federation/policy` | 受付、同時枠、ホストに残すRAM・空き容量 |
| `POST /api/cloud-federation/peers` | 相手鍵とURLの固定・失効 |
| `POST /api/cloud-federation/a2a` | `objective`と`sessionId`によるAI対話の開始・照合再開 |
| `GET /api/cloud-federation/groups/:peerId` | 相手とのグループ全体の確認 |
| `POST /api/cloud-federation/orders` | 明示的な構造化注文・見積り（診断用の低レベルAPI） |
| `POST /api/cloud-federation/orders/:id/:action` | commit／status／cancel、応答消失時のreconcileによる同じ注文の照合 |
| `POST /api/cloud-federation/peer` | グループID付き署名要求・署名応答 |

APIの固定操作名はプロトコル列挙であり、自然言語の意図分類ではない。正常系の利用者フローはAI同士の対話を基本とする。

## 7. 検証と証拠

最終検収：このPCのNode.js環境で型検査成功、関連63試験が成功（失敗0、スキップ0）。別プロセスの最小内核、2つのローカルHTTPノード、模擬AIのA2A、WorkbenchのグループAPI、DOM上の画面操作を含む。実ブラウザーの目視確認、実モデルの判断品質、異なる実PC間の検証とは区別する。実運用のGateway再起動・設定変更・公開は実施していない。

再現用の入口は [PowerShell版](../scripts/verify-decentralized-cloud.ps1) と [Python版](../scripts/verify-decentralized-cloud.py)。PythonがなくてもPowerShell版を利用できる。結果は指定した保存先、未指定なら一時フォルダーへ出力する。

```text
pwsh -NoProfile -File scripts/verify-decentralized-cloud.ps1 -Output docs/evidence/decentralized-cloud/20261017
python scripts/verify-decentralized-cloud.py --output docs/evidence/decentralized-cloud/20261017
```

試験は一時台帳・試験鍵・模擬AI・空きループバックポートに隔離する。実利用の8787番、実モデル、本番残高、外部サービスを使わない。型検査、署名改変・再送・宛先、AI拒否・不正JSON、予約競合、再起動、結果不明、応答消失、独立HTTPノード、別プロセスの最小内核、構成復元、Plugin拡張、A2A完了根拠、グループ保存不能、Workbenchでの閲覧と既存回帰を対象にする。

ローカル証拠は `docs/evidence/decentralized-cloud/20261017/result.json` と `check-*.log`。証拠フォルダーは既存のGit除外対象である。最初のHTTP試験はサンドボックスのループバック接続拒否で失敗し、通常権限で再検証した。グループ追加後に同時保存の競合を検出し、グループ単位の直列化と結果不明の扱いを修正した。最終結果は結果JSONで確認する。

PowerShell版で実行を確認する。Python版はこのPCの `python`／`py` に実体が見つからなかったため、実行確認は未実施。外部のPython導入は行っていない。

## 8. 残条件

- 実モデルによる判断品質・長時間保守・実際の利用量と費用の確認。
- 異なる実PC・NAT・HTTPS公開・鍵回復・失効伝播の実機検証。
- GPU・Docker・Kubernetes・VM等の追加実行Pluginと各機器での検証。
- 大きな成果物の転送、ジョブ取消、外部副作用がある処理の照合と隔離。
- 多者グループ、検索・中継Plugin、履歴再同期、グループ保全・運用。
- 共通WTCの合意・発行・精算・不正耐性・制度上の整理。
- 内核のハングを外部から復旧する監督、署名付きアップデート配布。

現段階ではゼロ価格の試験契約だけを扱い、残高・発行・送金機能は実装していない。AIが提案したこと、コードを追加したこと、隔離試験で動いたこと、実利用で提供可能なことを区別する。
