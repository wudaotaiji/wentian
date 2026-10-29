# Wentian 0.6.0 — Workbench と成果検証

公開準備日: 2026年9月28日（JST）

## この版でできること

1. 作成したタスクを、進捗・検証結果・実行ログと一緒に工作台で確認する。
2. 選択モデルとローカルツールでタスクを実行し、ステップ終了時の一時停止、追加指示、再開を操作する。
3. Agentの自己申告と独立して、成果物の存在・非空・指定文字列をホスト側で検証し、SHA-256を保存する。
4. Skillsを発見して必要時だけ読み込み、ローカルのSKILL.mdをプロジェクトにインストールする。
5. 初回ガイドで接続先を保存し、モデル応答を試してからサンプルタスクを作成する。

## 起動

```powershell
wentian setup --port auto
```

ブラウザーが工作台の `/workbench` を開きます。既存Gatewayを使う場合はControl Centerの「Task Workbench · 初回設定」リンクから移動してください。

管理者でログインしてください。未設定の場合、ローカル接続から初回管理者を作成できます。既存の `WENTIAN_ADMIN_USERNAME` / `WENTIAN_ADMIN_PASSWORD` とControl Centerセッションも利用できます。

作業場所はGatewayの起動フォルダーです。`WENTIAN_TASK_WORKSPACE` が設定されている場合はそのフォルダーに固定します。API本文から任意の作業場所を指定することはできません。工作台APIは管理者セッションまたはGateway APIキーが必要です。

## 初回ガイド

1. ローカルまたはクラウドのOpenAI互換URLと、必要な場合だけAPIキーを保存する。
2. モデル一覧から選択し、「短いテストを送信」で実際の応答を確認する。
3. 「サンプルを準備」で、日時を付けた新規Markdownファイルを作るタスクを用意する。
4. タスクの「実行・再開」を押す。
5. ファイルの存在と `Wentian ready` という文字列が確認されると完了になる。

接続設定はインストール先の `.wentian/onboarding-provider.json` に保存します。APIキーもこのローカルファイルに保存されるため、ファイルを共有しないでください。リポジトリの `.gitignore` は `.wentian/` を除外しています。通常の `providers.json` は書き換えません。接続設定は保存後すぐ反映され、Gatewayの再起動後も読み込まれます。

モデル応答テストとタスク実行は別の確認です。タスクでファイルを作るにはツール呼び出しに対応したモデルが必要です。外部Agentのインストールは初回サンプルの必須条件ではありません。

## 成果検証

タスク作成時に成果物の相対パスと、必要なら含まれるべき文字列を指定します。APIでは20件まで指定できます。

```json
{
  "title": "調査レポートを作成",
  "description": "対象プロジェクトの調査結果をreports/summary.mdに保存する",
  "acceptance": [
    { "path": "reports/summary.md", "contains": "検証結果" }
  ]
}
```

検証は2MiB以内の空でない通常ファイルを対象とします。作業領域外のパスやリンク先は拒否します。実行前の条件をコピーして検証に用いるため、実行途中にGoalファイルが変更されても条件は差し替わりません。

条件未設定・ファイル未作成・内容不一致の場合、タスクは成果物を残したまま「検証待ち」で一時停止します。「指示・検証条件を修正」で条件や指示を追加してから再開するか、ファイルを修正して「成果を再検証」を押してください。保留項目や空のGoalを完了として扱わなくなりました。

既存CLIで作成したGoalにも同じ検証規則が適用されます。条件を持たない旧Goalは実行後に検証待ちになります。工作台から条件を追加してください。

**検証範囲:** 指定ファイルと文字列の確認です。アプリ全体の品質、任意のコマンドテスト、スクリーンショットの意味的な正しさを自動保証する機能ではありません。既存の自己改善品質ゲートは引き続き別途利用できます。

## Skills

```powershell
wentian skills list
wentian skills show verified-delivery
wentian skills install C:\path\to\SKILL.md
```

発見順は、プロジェクトの `.wentian/skills/`、`.agents/skills/`、ユーザーの `~/.wentian/skills/`、同梱Skillsです。同名定義は先に発見したものを採用します。名前と1行の説明を一覧に提示し、ツールを使うAgentは `list_skills` / `load_skill` で必要な本文だけ読み込みます。

```markdown
---
name: project-review
description: プロジェクトの設定と起動手順を読み取り専用で調査する。
---

READMEと設定ファイルを確認し、出典ファイルと不明点を報告してください。
```

名前はディレクトリ名と一致する英小文字・数字・ハイフン、最大64文字です。定義は64KiB以内で、フロントマターの `name` と1行の `description` が必要です。インストールは単一のSKILL.mdをコピーし、既存の同名ファイルを上書きしません。説明のYAML複数行記法、リモート配布、補助ファイル一式のインストールは今回の対象外です。

同梱: `verified-delivery`、`project-overview`、`incident-triage`。

## 工作台API

| 操作 | エンドポイント |
|---|---|
| Goal・セッション・Skillsの一覧 | `GET /api/workbench` |
| モデル一覧 | `GET /api/workbench/models` |
| 接続設定の保存 | `POST /api/workbench/connection` |
| モデル応答テスト | `POST /api/workbench/test-model` |
| タスク作成 | `POST /api/workbench/goals` |
| 実行／ステップ終了時停止／修正／再検証 | `POST /api/workbench/goals/:id/run|pause|revise|verify` |
| ログ末尾 | `GET /api/workbench/goals/:id/log` |
| Skill本文 | `GET /api/workbench/skills/:name` |

工作台では同じ作業場所のタスクを同時実行しません。一時停止は実行中のステップ終了後です。子プロセスはブラウザーを閉じても動作を続けます。隔離コンテナでの実行やOSレベルのサンドボックスではありません。

表示するToken数は実行応答から取得できた使用量です。Plannerと外部Agentの消費量、料金の集計は含みません。未設定の料金を推測して表示しません。

## 修正した関連不具合

- 別の作業フォルダーからCLIを起動したとき、インストール先のプラグイン設定へフォールバックする。
- WindowsのNode.js子プロセスでtsxローダーをfile URLで読み込む。
- Goal保存先を子プロセスへ引き継ぐ。
- ファイル先読みが成功・失敗した場合も、その後のツール実行を無効にしない。
- APIキーを設定したGatewayへ、Plannerと実行CLIから認証ヘッダーを送る。
- PID確認をOSに問い合わせ、tasklist出力の不正な解析による誤判定をなくす。
