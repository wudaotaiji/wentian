// 実行許可の試験も利用者の運用設定から隔離します。
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
// 実行許可と監査も本番設定から分離します。実CLIの起動には試験ごとの明示許可が必要です。
process.env.WENTIAN_EXECUTION_POLICY_FILE = path.join(os.tmpdir(), `wentian-test-execution-${process.pid}.json`);
process.env.WENTIAN_EXECUTION_AUDIT_FILE = path.join(os.tmpdir(), `wentian-test-execution-${process.pid}.jsonl`);
// 既定の保守許可を検証する試験だけが明示的に有効化し、他の試験から実CLIを起動させません。
process.env.WENTIAN_DEFAULT_MAINTENANCE_ACCESS = 'false';
process.env.WENTIAN_PROVIDER_DATA_POLICY_FILE = path.join(os.tmpdir(), `wentian-test-provider-policy-${process.pid}.json`);
process.env.WENTIAN_PROVIDER_DATA_AUDIT_FILE = path.join(os.tmpdir(), `wentian-test-provider-audit-${process.pid}.jsonl`);
// 単体試験が実際の常駐保守キャッシュを読み書きしないよう、プロセス別に隔離します。
process.env.WENTIAN_AGENT_CONNECTION_CACHE = path.join(os.tmpdir(), `wentian-test-connections-${process.pid}.json`);
process.env.WENTIAN_AI_MAINTENANCE_ROOT = path.join(os.tmpdir(), `wentian-test-ai-maintenance-${process.pid}`);
// 性能台帳（Performance Ledger）も実利用履歴から分離して保存・復元を検証します。
process.env.WENTIAN_EVENT_STORE = path.join(os.tmpdir(), `wentian-test-events-${process.pid}.jsonl`);
process.env.WENTIAN_AGENT_READY_CACHE = path.join(os.tmpdir(), `wentian-test-readiness-${process.pid}.json`);
// 模擬応答の速度・成功率を利用者の性能順位へ混入させません。
process.env.WENTIAN_AGENT_PERFORMANCE_FILE = path.join(os.tmpdir(), `wentian-test-performance-${process.pid}.json`);
// 端末配色の試験も利用者の表示設定へ書き込みません。
process.env.WENTIAN_TERMINAL_SETTINGS_FILE = path.join(os.tmpdir(), `wentian-test-terminal-${process.pid}.json`);
process.env.WENTIAN_CLI_SETTINGS_FILE = path.join(os.tmpdir(), `wentian-test-cli-language-${process.pid}.json`);
// 画像制作の証跡も本番の成功記録を参照・変更しません。
process.env.WENTIAN_CODEX_IMAGE_EVIDENCE = path.join(os.tmpdir(), `wentian-test-codex-image-${process.pid}.json`);
process.env.WENTIAN_AGENT_MAINTENANCE_SETTINGS = path.join(os.tmpdir(), `wentian-test-maintenance-${process.pid}.json`);
// サーバーテストが実際のCLIを自動起動しないようにします。管理器の専用試験では依存を差し替えて開始します。
process.env.WENTIAN_AGENT_MAINTENANCE_ENABLED = 'false';
process.env.WENTIAN_MAINTENANCE_CONTROLS_FILE = path.join(os.tmpdir(),`wentian-test-controls-${process.pid}.json`);
process.env.WENTIAN_AGENT_WORK_CACHE = path.join(os.tmpdir(), `wentian-test-work-${process.pid}/capabilities.json`);
// 使用禁止の試験もユーザーの実設定を参照・変更しません。
process.env.WENTIAN_AGENT_EXCLUSIONS_FILE = path.join(os.tmpdir(), `wentian-test-exclusions-${process.pid}.json`);
process.env.WENTIAN_AGENT_REGISTRATIONS_FILE = path.join(os.tmpdir(), `wentian-test-registrations-${process.pid}.json`);
// Provider CRUD試験の接続設定を実環境の管理ファイルから隔離します。
process.env.WENTIAN_PROVIDER_MANAGEMENT_FILE = path.join(os.tmpdir(), `wentian-test-providers-${process.pid}.json`);
process.env.WENTIAN_USER_STORE = path.join(os.tmpdir(), `wentian-test-users-${process.pid}.json`);
process.env.WENTIAN_AGENT_MANAGEMENT_FILE = path.join(os.tmpdir(), `wentian-test-agent-management-${process.pid}.json`);
process.env.WENTIAN_AGENT_INSTALL_CACHE=path.join(os.tmpdir(),`wentian-test-installations-${process.pid}.json`);
// 実際のCLI導入は個別に依存を差し替えた試験だけで有効化します。
process.env.WENTIAN_AGENT_AUTO_INSTALL='false';
process.env.WENTIAN_MANUAL_AGENTS_FILE = path.join(os.tmpdir(), `wentian-test-manual-agents-${process.pid}.json`);
// Goal（工作台のタスク）も実台帳 `.wentian/goals/` へ書かせません。
// goalsRoot() は WENTIAN_GOAL_PATH 未設定だと `<cwd>/.wentian/goals` に落ちるため、
// createGoal() を呼ぶ試験がそのままリポジトリの実台帳を汚していました（git-checkpoint +6件、memory-layer +1件/回）。
// 個別の試験が自分で WENTIAN_GOAL_PATH を設定する場合は、この後の代入が上書きするのでそのまま優先されます。
process.env.WENTIAN_GOAL_PATH = path.join(os.tmpdir(), `wentian-test-goals-${process.pid}`);
process.env.WENTIAN_TEAM_ACCESS_ROOT = path.join(os.tmpdir(), `wentian-test-team-${process.pid}`);
process.env.WENTIAN_PROJECT_KNOWLEDGE_ROOT = path.join(os.tmpdir(), `wentian-test-knowledge-${process.pid}`);
process.env.WENTIAN_WORKFLOW_ROOT = path.join(os.tmpdir(), `wentian-test-workflows-${process.pid}`);
// MCP設定・監査も利用者の接続を読まず、テストプロセスごとに分離します。
process.env.WENTIAN_MCP_CLIENT_CONFIG = path.join(os.tmpdir(), `wentian-test-mcp-${process.pid}`, 'servers.json');
process.env.WENTIAN_MCP_CLIENT_AUDIT = path.join(os.tmpdir(), `wentian-test-mcp-${process.pid}`, 'audit.jsonl');
// 試験用のGoal退避先は進程ごとに1つ残ります。放置すると一時領域が膨らむため、終了時に片付けます。
// 失敗しても試験結果を壊さないよう、片付けの例外は飲み込みます（Windowsのファイルロックで残ることがある）。
process.on('exit', () => { try { rmSync(process.env.WENTIAN_GOAL_PATH || '', { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* 片付け失敗は試験を失敗にしない */ } });


// Personal CloudのSQLite台帳も本番データから分離します。
process.env.WENTIAN_CLOUD_STORE = path.join(os.tmpdir(), `wentian-test-cloud-${process.pid}`, 'cloud.sqlite');
process.env.WENTIAN_COMMERCE_STORE = path.join(os.tmpdir(), `wentian-test-commerce-${process.pid}`, 'commerce.sqlite');
process.env.WENTIAN_NODE_HOME = path.join(os.tmpdir(), `wentian-test-node-${process.pid}`);
// 動画生成も実際の作品・モデル保存先から分離します。
process.env.WENTIAN_VIDEO_ROOT = path.join(os.tmpdir(), `wentian-test-videos-${process.pid}`);
// 会話の能力診断も利用者の実モデル・Pythonを読まないよう未準備の試験環境へ隔離します。
// 実推論は専用の検証スクリプトで明示的に実行し、単体試験でPyTorchを大量起動しません。
process.env.WENTIAN_VIDEO_PYTHON = path.join(os.tmpdir(), `wentian-test-engine-${process.pid}`, 'python');
process.env.WENTIAN_VIDEO_MODEL_PATH = path.join(os.tmpdir(), `wentian-test-engine-${process.pid}`, 'model');
process.env.WENTIAN_AUDIO_MODEL_ROOT = path.join(os.tmpdir(), `wentian-test-engine-${process.pid}`, 'audio-models');

// 音声制作の試験台帳も実作品から分離します。
process.env.WENTIAN_MEDIA_ROOT = path.join(os.tmpdir(), `wentian-test-media-${process.pid}`);
// 書房の試験から実際のJupyter環境・ノートブックへ接続しません。
process.env.WENTIAN_JUPYTER_MODULE_ROOT = path.join(os.tmpdir(), `wentian-test-jupyter-${process.pid}`);
process.env.WENTIAN_JUPYTER_NOTEBOOK_ROOT = path.join(os.tmpdir(), `wentian-test-notebooks-${process.pid}`);

process.env.WENTIAN_MEDIA_MAINTENANCE_ROOT = path.join(os.tmpdir(), `wentian-test-media-maintenance-${process.pid}`);
process.env.WENTIAN_MEDIA_MODEL_MAINTENANCE = 'false';
// 分類の単体試験から利用者の学習重み・外部CLIを起動しません。代替試験だけ個別に有効化します。
process.env.WENTIAN_PLANNER_TRAINING_ROOT = path.join(os.tmpdir(), `wentian-test-planner-training-${process.pid}`);
process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK = 'false';
