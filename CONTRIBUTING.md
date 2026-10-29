# Wentian Gatewayへの開発参加

Wentian Gatewayへの関心と協力をありがとうございます。バグ報告、機能提案、ドキュメント改善、テスト追加、コード修正など、規模を問わずContribution（貢献 / Contribution）を歓迎します。

参加前に [行動規範](./CODE_OF_CONDUCT.md) を確認してください。コードとドキュメントは [MIT License](./LICENSE) のもとで公開されます。

## 参加方法

- 不具合を見つけた場合は、[不具合報告フォーム](https://github.com/wudaotaiji/wentian/issues/new?template=1-bug-report.yml)へ再現手順と環境情報を投稿してください。
- 新機能は、[機能提案フォーム](https://github.com/wudaotaiji/wentian/issues/new?template=2-feature-request.yml)で目的と利用例を共有するとレビューしやすくなります。
- 誤字、説明不足、小さなテスト追加は、直接Pull Requestを作成して構いません。
- セキュリティ上の問題や認証情報は、公開Issueへ秘密値を掲載しないでください。

## 必要な環境

- Windows 10またはWindows 11
- Git
- Node.js 20以降
- npm
- Windows PowerShellまたはPowerShell 7

現在の主な実装言語はTypeScriptです。プロジェクトは `package-lock.json` で依存関係を固定しています。

## リポジトリをCloneする

リポジトリへ直接Pushする権限がない場合は、最初にGitHub上の `Fork` ボタンで自分のアカウントへForkしてください。

公式リポジトリを直接Cloneする場合:

```powershell
Set-Location -LiteralPath 'C:\workspace'
git clone https://github.com/wudaotaiji/wentian.git
Set-Location -LiteralPath 'C:\workspace\wentian-gateway'
```

ForkしたリポジトリをCloneする場合は、`YOUR_GITHUB_NAME` を自分のGitHubユーザー名へ置き換えます。

```powershell
Set-Location -LiteralPath 'C:\workspace'
git clone https://github.com/YOUR_GITHUB_NAME/wentian.git wentian-gateway
Set-Location -LiteralPath 'C:\workspace\wentian-gateway'
git remote add upstream https://github.com/wudaotaiji/wentian.git
git remote -v
```

## 開発環境を準備する

```powershell
Copy-Item -LiteralPath '.env.example' -Destination '.env'
npm ci
npm run build
npm test
```

`.env` はローカル設定専用で、GitへCommit（記録 / Commit）しません。APIキー、トークン、パスワードなどの秘密情報をソース、テストデータ、ログ、Issue、Pull Requestへ含めないでください。

Gatewayを開発モードで起動します。

```powershell
npm run dev
```

別のPowerShellから動作を確認できます。

```powershell
curl.exe -sS http://127.0.0.1:8787/health
curl.exe -sS http://127.0.0.1:8787/v1/models
```

## 作業ブランチを作る

`main` を直接変更せず、目的が分かる短いブランチ名を使用します。

```powershell
git switch main
git pull --ff-only upstream main
git switch -c fix/short-description
```

公式リポジトリを直接Cloneし、`upstream` を登録していない場合は、`git pull --ff-only origin main` を使用してください。

推奨する接頭辞:

| 接頭辞 | 用途 | 例 |
|---|---|---|
| `fix/` | 不具合修正 | `fix/sse-disconnect` |
| `feat/` | 機能追加 | `feat/provider-health` |
| `docs/` | 文書更新 | `docs/clone-guide` |
| `test/` | テスト改善 | `test/router-fallback` |
| `refactor/` | 振る舞いを変えない整理 | `refactor/provider-loader` |

## 文書を追加・更新する

新しいMarkdown文書は `docs/agent_groups_validation.md` のように、日付を先頭に付けず、小文字のASCII `snake_case` で命名します。内容を表す安定した名前を選び、作業日や更新日は必要に応じて文書本文へ記載してください。既存文書を改名した場合は、README、文書間リンク、コードやスクリプト内の参照も更新します。

## 変更を検証する

Pull Requestを作る前に、少なくとも型検査と自動テストを実行します。

```powershell
npm run build
npm test
git status --short
git diff
```

テストが失敗した場合は、失敗を隠したりテストを削除したりせず、次の情報をPull Requestへ記載してください。

- 失敗したテスト名
- 完全な実行コマンド
- 実行環境とNode.jsバージョン
- 今回の変更前にも発生したか
- 再現手順または関連ログ

Gatewayと実プロバイダーを含むE2E（エンドツーエンド / End-to-End）検証は [公開機能と制限](docs/feature_scope.md) を参照してください。

## Commitを作成する

1つのCommitには、レビュー可能な1つの目的をまとめます。

```powershell
git add --all
git status --short
git commit -m "fix: describe the change"
```

生成物、`node_modules/`、`.env`、一時ファイル、個人用設定をCommitしないでください。

## Pull Requestを送る

Forkから送る場合:

```powershell
git push -u origin fix/short-description
```

GitHubで自分のブランチから `wudaotaiji/wentian:main` 宛てのPull Requestを作成し、次を記載してください。

- 変更の目的と背景
- 主な変更点
- 確認したコマンドと結果
- 未解決事項または既知の制約
- UI変更がある場合は画面キャプチャ
- 関連Issueがある場合はIssue番号

Pull Requestの例:

```markdown
## 目的

SSE切断時にGatewayが終了する問題を修正します。

## 変更内容

- 上流ストリームへエラーハンドラーを追加
- 切断後のHealth確認テストを追加

## 検証

- `npm run build`: 成功
- `npm test`: 成功

## 関連Issue

Closes #123
```

## レビュー基準

Pull Requestでは主に次を確認します。

- 変更目的が明確で、対象範囲が必要最小限であること
- OpenAI互換APIの既存動作を壊していないこと
- 認証情報やプロンプトを平文ログへ出力しないこと
- 外部入力、URL、ファイルパスを適切に検証すること
- 新しい振る舞いに対応するテストまたは検証根拠があること
- READMEや正式仕様に影響する変更では文書も更新されていること

レビューで修正依頼が出ることがあります。これは参加を拒否するものではなく、安全性と保守性を一緒に高めるための通常の工程です。

## 最新のmainを取り込む

Pull Request作業中に公式リポジトリが更新された場合:

```powershell
git fetch upstream
git rebase upstream/main
git push --force-with-lease
```

`--force-with-lease` は自分の作業ブランチだけで使用し、共有ブランチや `main` には使用しないでください。

## 質問と相談

手順が分からない場合や、実装方針を相談したい場合はGitHub Issueを作成してください。完成したコードがなくても、再現例、期待する動作、設計案、検証結果の共有は有用なContributionです。
