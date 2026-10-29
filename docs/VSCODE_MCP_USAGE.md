# VS CodeからWentian MCPサーバーを利用する

更新日: 2026-10-05

Wentianは公式MCP SDK（ソフトウェア開発キット / Software Development Kit）によるStreamable HTTPサーバーを `/mcp` に提供します。初期化・能力交渉・セッション・SSE通知・終了と、ツール／リソース／プロンプトを扱います。逆方向は [MCPクライアント利用方法](./MCP_CLIENT_USAGE.md) を参照してください。

公式SDKクライアントによるHTTP・stdio結合検証を実施しています。**VS Code／GitHub Copilotの実製品画面での接続・操作は未確認**です。全MCP拡張・全製品への完全互換を表明しません。

## 接続先の違い

| 用途 | 接続先 |
|---|---|
| 外部アプリからWentianのツール・資料を使う | `http://127.0.0.1:8787/mcp` |
| OpenAI互換チャットを使う | `http://127.0.0.1:8787/v1` |
| 外部MCP接続の管理画面 | `http://127.0.0.1:8787/mcp-connections` |

MCP登録はCopilotの推論モデルをWentianへ変更する設定ではありません。

## Gatewayの準備

`.env` に `WENTIAN_ENABLE_MCP=true` を設定してGatewayを起動・再起動します。APIキーを利用する場合は `WENTIAN_API_KEY` を設定してください。外部Agentによる制作も実行するときだけ `WENTIAN_ENABLE_EXTERNAL_ORCHESTRATION=true` を設定します。

```powershell
# Gatewayを起動します。既に常駐している場合は二重起動せず再起動してください。
wentian daemon start --port 8787

# 初期化、ツール発見、終了を確認します。PowerShell 7が必要です。
# 認証キーはWENTIAN_MCP_API_KEYまたはWENTIAN_API_KEYから取得し、表示しません。
pwsh -NoProfile -File scripts/test-mcp.ps1 -BaseUrl http://127.0.0.1:8787
```

```python
import subprocess

# Python版でも、同じ読み取り確認を実行できます。
# 認証キーは継承される環境変数に設定済みとします。
subprocess.run(["python", "scripts/test-mcp.py", "http://127.0.0.1:8787"], check=True)
```

直接 `GET /mcp` でサーバー情報を取得する旧手順は使えません。初期化済みセッションのGETは通知ストリームです。POSTも `initialize`、`notifications/initialized`、返却された `Mcp-Session-Id` の引き継ぎが必要なので、上記スクリプトかSDKを使ってください。

## VS Code設定

以下は既存のVS Code形式 `.vscode/mcp.json` へ追加する互換用の例です。既存設定がある場合は全体を上書きせず `servers` へ追加します。

2026-10-05確認の [VS Code公式手順](https://code.visualstudio.com/docs/agent-customization/mcp-servers) は、新規設定にプロジェクト直下の `.mcp.json`（トップレベル `mcpServers`）などのポータブル（Portable）形式を推奨しています。Agent Hostは `.vscode/mcp.json` を直接読みません。また、以下の `${input:...}` による対話入力を必要とするサーバー設定はAgent Hostへ転送されません。その環境では「MCP: Add Server」から適切な保存先と秘密値の渡し方を選択してください。[設定形式の公式資料](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)

```json
{
  "inputs": [
    { "type": "promptString", "id": "wentian-api-key", "description": "Wentian API Key", "password": true }
  ],
  "servers": {
    "wentian": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer ${input:wentian-api-key}" }
    }
  }
}
```

APIキーを設定しないローカル運用では `inputs` と `headers` を省略できます。別キー／別利用者へ既存セッションを流用できません。

### stdio（標準入出力）ブリッジ

HTTP Gatewayは別途起動したまま、VS Codeから公式SDKブリッジを起動できます。標準出力はプロトコル専用です。

```json
{
  "servers": {
    "wentian": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/workspace/wentian-gateway/scripts/mcp-wrapper.cjs"],
      "env": { "WENTIAN_MCP_BASE_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

認証はブリッジプロセスの `WENTIAN_MCP_API_KEY`、未設定なら `WENTIAN_API_KEY` からBearerとして転送します。利用するクライアントが秘密を安全に渡せる方法を使ってください。起動用PowerShell／Python版も `scripts/mcp-stdio.ps1`、`scripts/mcp-stdio.py` にあります。

## 公開機能

| ツール | 主な必須引数 |
|---|---|
| `wentian_submit_task` | `prompt` |
| `wentian_get_task`・`wentian_cancel_task`・`wentian_get_result` | `task_id` |
| `wentian_run_data_patrol` | `system_prompt`, `user_request`, `catalog`, `schema`, `table` |
| `wentian_list_workflows` | なし |
| `wentian_get_workflow`・`wentian_run_workflow` | `workflow_id` |
| `wentian_get_workflow_run`・`wentian_cancel_workflow_run` | `run_id` |
| `wentian_list_workflow_runs` | なし。フィルターとページ指定可 |

実際の `tools/list` の入力スキーマを確認してください。ワークフローとパトロールは対応上流サービス・設定が必要です。ワークフロー開始で `CREATED` が返っても実処理完了ではありません。

| 機能 | 内容 |
|---|---|
| リソース | 認証主体が所有する `wentian://tasks/{task_id}` |
| テンプレート | `wentian://tasks/{task_id}`、タスクID補完 |
| 購読 | タスク変更の `notifications/resources/updated` |
| プロンプト | `wentian-task-plan`。必須引数 `request` |
| ログ | ツール名と成否。依頼・結果本文・キーを含めない |

具体例は [公開機能と制限](feature_scope.md) を参照してください。

## セッション・認証・制限

- セッションは認証主体固定。別主体の流用を拒否し、不明セッションの404では再初期化します。
- 30分無通信で終了し、DELETEで明示終了できます。Gateway再起動後も再初期化が必要です。
- 標準キャンセルはSDKで処理します。登録済み永続タスクは `wentian_cancel_task` で中断。HTTP取り消しとタスク中断は別です。
- Host既定許可はlocalhost、127.0.0.1、IPv6ループバック。外部公開は `WENTIAN_MCP_ALLOWED_HOSTS` へホスト名を明示します。ブラウザーは同一Originまたは `WENTIAN_MCP_ALLOWED_ORIGINS` の許可先のみ。
- タスクは `WENTIAN_TASK_ROOT` または `.wentian/tasks` へ保存し、複数Gatewayで同じrootを共有しません。
- ツール結果の `isError: true` は業務失敗です。HTTP 200だけで完了と判断しません。
- OAuth認可サーバーとMCP Tasks拡張は未提供。WentianタスクID照会は別機能です。

## トラブルシューティング

401はキー／ログイン、403は所有者・Host・Origin、404は公開有効化またはセッションを確認します。ツールが見えない場合は読み取り確認スクリプトを先に実行し、VS CodeのMCP出力を確認してください。stdioはNode、絶対パス、認証環境変数、Gateway起動状態を確認します。

- [VS CodeのMCPサーバー管理](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
- [MCP設定リファレンス](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
