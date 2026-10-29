import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import path from 'node:path';
import {
  assertConfinedAllowedWritePaths, buildConfinedPlan, runConfinedExternalTask,
  CONFINED_LIMITS, type ConfinedExternalTaskResult,
} from './confined-external-task.js';
import { validateAcceptance, type AcceptanceCheck } from './delivery-verification.js';

/**
 * 限定外部タスクAPI（Confined External Task Routes）— P0
 *
 * 接続手順（既存本体 src/server.ts への組み込み側へ渡す前提 / Integration Note）:
 *  - `registerConfinedExternalTaskRoutes(app, { workspace, authorize, model })` を
 *    server.ts の `registerWorkbench(app, {...})` を呼ぶ直後と同じ箇所で呼ぶ。
 *  - `authorize(req, reply)` は workbench と同じ関数实例を再利用する（既定実装:
 *    ゲートウェイキー一致か `requireAdmin(req, reply)` の管理者IDで判定）。
 *  - `model` はホスト設定の管理済みモデルID（例: process.env.WENTIAN_CLAUDE_MODEL）。
 *    未設定なら本APIは 503 を返し、Claudeを一切起動しない（可変モデル・利用者のモデル指定は不可）。
 *
 * セキュリティ上の不変条件:
 *  - リクエスト本文は { prompt, allowedWritePaths, acceptanceChecks } の3キーのみ。
 *    executable / args / model / command 等の未知キーは 400 で拒否し、利用者に実行文件を指定させない。
 *  - 認証（authorize）を通るまで何も検証せず、Claudeも起動しない（fail-closed）。
 *  - 依頼文（prompt）・Claude応答生データを API応答へ一切載せない（返すのはパス・ハッシュ・状態のみ）。
 *  - OSサンドボックスではない: CLIの旗とホスト側検証による約束（Contract）である。
 */

/** 承認関数。workbench の authorize（ゲートウェイキー or 管理者）と同じ形を想定。 */
export type ConfinedTaskAuthorizer = (req: FastifyRequest, reply: FastifyReply) => boolean | Promise<boolean>;

export interface ConfinedExternalTaskRouteOptions {
  /** 対象ワークスペース（原本）。隔離複製・受入・反映は runDirectTask が安全側で制御する。 */
  workspace: string;
  /** 必須の権限関数。false / 例外 はすべて拒否（fail-closed）。 */
  authorize: ConfinedTaskAuthorizer;
  /** ホスト固定の管理済みモデルID。未設定なら 503（このAPIは実行しない）。 */
  model?: string;
  /** 試験・運用差し替え用（既定: 実 runConfinedExternalTask）。 */
  runTask?: (plan: Parameters<typeof runConfinedExternalTask>[0], workspace: string, options: Parameters<typeof runConfinedExternalTask>[2]) => Promise<ConfinedExternalTaskResult>;
}

/** OpenAI互換と同じ:error:{message,type,code}形。内部詳細（パスの全容・CLIstderr）は出さない。 */
const apiError = (message: string, type: string, code: string) => ({ error: { message, type, code } });

/** リクエストボディのホワイトリスト検証。想定外キー（executable等）は理由を絞って400にする。 */
function validateBody(body: unknown): { prompt: string; allowedWritePaths: string[]; acceptanceChecks: unknown } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('本文はオブジェクトで指定してください。'), { statusCode: 400, code: 'invalid_body' });
  const record = body as Record<string, unknown>;
  const allowedKeys = new Set(['prompt', 'allowedWritePaths', 'acceptanceChecks']);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) throw Object.assign(new Error(`許可されていないボディキーです: ${key}`), { statusCode: 400, code: 'unknown_body_key' });
  }
  const prompt = record.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) throw Object.assign(new Error('依頼文（prompt）は必須です。'), { statusCode: 400, code: 'invalid_prompt' });
  if (prompt.length > CONFINED_LIMITS.maxPromptChars) throw Object.assign(new Error(`依頼文は${CONFINED_LIMITS.maxPromptChars}文字以内です。`), { statusCode: 400, code: 'prompt_too_long' });
  if (!Array.isArray(record.allowedWritePaths) || !record.allowedWritePaths.length
    || record.allowedWritePaths.some(value => typeof value !== 'string' || !value.trim())) {
    throw Object.assign(new Error('allowedWritePaths は具体ファイルパスの文字列配列（1件以上）です。'), { statusCode: 400, code: 'invalid_allowed_write_paths' });
  }
  // API利用者には相対パスのみ要求する（絶対パスの許容はホスト内部の正規化に任せる）。
  if (record.allowedWritePaths.some(value => path.isAbsolute(String(value)))) {
    throw Object.assign(new Error('allowedWritePaths はワークスペースからの相対パスで指定してください。'), { statusCode: 400, code: 'invalid_allowed_write_paths' });
  }
  return { prompt, allowedWritePaths: record.allowedWritePaths as string[], acceptanceChecks: record.acceptanceChecks };
}

/** ルート登録本体。server.ts からは registerWorkbench の直後に呼ぶ。 */
export function registerConfinedExternalTaskRoutes(app: FastifyInstance, options: ConfinedExternalTaskRouteOptions): void {
  const runTask = options.runTask || (async (plan, workspace, taskOptions) => runConfinedExternalTask(plan, workspace, taskOptions));

  /** 限定外部タスク起動。成功/要確認/失敗はすべて outcome.status で返し、HTTP異常と混同させない。 */
  app.post('/api/workbench/confined-task', { bodyLimit: 1_048_576 }, async (req, reply) => {
    // ① 認証・認可（最優先・fail-closed）。拒否時はデータ検証もCLI起動も行わない。
    let allowed = false;
    try { allowed = await options.authorize(req, reply) === true; } catch { allowed = false; }
    if (!allowed) return reply.sent ? reply : reply.code(403).send(apiError('限定外部タスクを実行する権限がありません。', 'permission_error', 'confined_task_forbidden'));

    // ② ホスト固定モデルの必須確認。未設定では起動しない（503 = サーバー設定未備）。
    const model = String(options.model || '').trim();
    if (!model) return reply.code(503).send(apiError('限定外部タスクの管理済みモデルが未設定のため実行できません。サーバー設定（WENTIAN_CLAUDE_MODEL 等）を確認してください。', 'server_unavailable', 'confined_model_not_configured'));

    // ③ ボディのホワイトリスト検証（実行文件・引数・モデルの利用者指定はここで遮断）。
    let input: ReturnType<typeof validateBody>;
    try { input = validateBody(req.body); } catch (error) {
      const failure = error as { statusCode?: number; code?: string; message?: string };
      return reply.code(failure.statusCode || 400).send(apiError(failure.message || '本文が不正です。', 'validation_error', failure.code || 'invalid_body'));
    }
    let allowedPaths: string[]; let checks: AcceptanceCheck[];
    try {
      // ④ 許可書込みパスは具体ファイルのみ（ディレクトリ・ワイルドカード・秘密名・範囲外を400で弾く）。
      allowedPaths = assertConfinedAllowedWritePaths(options.workspace, input.allowedWritePaths);
      // ⑤ 受入検査は実行前に固定（validateAcceptance）。任意コマンドは受け取らない。
      checks = validateAcceptance(input.acceptanceChecks ?? []);
    } catch (error) {
      return reply.code(400).send(apiError(error instanceof Error ? error.message : '指定が不正です。', 'validation_error', 'invalid_confined_request'));
    }

    // ⑥ 実行。政策拒否（モデル形式・入力上限）は400、その他の例外は500へ寄せる。
    try {
      const plan = buildConfinedPlan(input.prompt, allowedPaths);
      const result = await runTask(plan, options.workspace, { model, acceptanceChecks: checks });
      // 応答には依頼文・応答生データを載せない。状態・パス・サイズ・ハッシュのみ。
      return reply.code(200).send({
        object: 'confined_external_task',
        status: result.outcome.status,
        exitCode: result.outcome.exitCode,
        taskId: result.outcome.taskId,
        manifestPath: result.outcome.manifestPath,
        reason: result.outcome.reason,
        model,
        changes: result.changes.map(change => ({ path: change.path, bytes: change.bytes, beforeHash: change.beforeHash, afterHash: change.afterHash })),
        ignoredProposalFields: result.ignoredProposalFields,
        cliLaunchCount: result.cliLaunchCount,
        inputFiles: result.inputFiles,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 政策・上限・形式の拒否は作業者が直せるため400、想定外障害は内部情報を伏せる500。
      if (/拒否|必須|以内|形式|範囲外|リンク|ディレクトリ|秘密|未設定|空/.test(message)) return reply.code(400).send(apiError(message, 'validation_error', 'confined_task_rejected'));
      return reply.code(500).send(apiError('限定外部タスクの処理に失敗しました。台帳（manifest）を管理者が確認してください。', 'server_error', 'confined_task_internal_error'));
    }
  });
}
