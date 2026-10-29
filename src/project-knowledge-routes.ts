import { registerKnowledgeWorkspace, type KnowledgeWorkspaceOptions } from './knowledge-workspace-routes.js';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { KnowledgeCollectionJobs } from './knowledge-collection-jobs.js';
import { knowledgeProfiles } from './knowledge-resource.js';
import { configuredKnowledgeEmbedder, type KnowledgeEmbedder } from './knowledge-embeddings.js';
import { collectProjectUrls, type KnowledgePageReader } from './knowledge-url-collector.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  KnowledgeError, ProjectKnowledgeStore, PROJECT_ID_PATTERN,
  MAX_CONTENT_CHARS, MAX_QUERY_CHARS, MAX_SEARCH_LIMIT,
} from './project-knowledge.js';

/**
 * P2 社内資料 API（Project Knowledge Routes）
 *
 * 接続手順（既存本体 src/server.ts への組み込み側へ渡す前提）:
 *  - `registerProjectKnowledgeRoutes(app, authorize, options)` を server.ts の他ルート登録と同じ箇所で呼ぶ。
 *  - `authorize(req, reply, projectId, write)` は必須の権限関数で、全経路・ストア触達前に必ず呼ぶ。
 *      - `write=true` は登録/更新/削除、`write=false` は一覧/検索/引用元取得。
 *      - 拒否する場合、自前で reply を send して false を返すか、send せずに false だけ返す（未送信ならこの層が403を入れる）。
 *      - 例外を投げた場合も拒否として扱う（fail-closed / 閉じる方向の失敗）。
 *  - 保存rootは `options.root` 未指定なら `WENTIAN_PROJECT_KNOWLEDGE_ROOT`、無ければ本機設定目录配下。
 *    試験は必ず mkdtemp（一時目録）の root を渡して実データから隔離する。
 *
 * セキュリティ上の不変条件:
 *  - 明示した公開URLのみ専用収集口で取得する。DNS検査・IP固定・転送先検査で内部接続を拒否する。
 *  - projectId はURLデコード後でも必ず規則検証（`../` 等の脱出・大文字・記号を400で弾く）。
 *  - 検索結果・引用には根拠（documentId/title/url/excerpt/行番号/revision/contentHash）を必ず添える。
 *  - 認証なし（authorize 拒否）の取得・変更は全て 401/403 で拒否し、データには一切触らせない。
 */

/** 権限関数（Authorizer）の型。既存本体の `requireAdmin` / ゲートウェイキー判定をここでラップして渡す。 */
export type ProjectKnowledgeAuthorizer = (req: FastifyRequest, reply: FastifyReply, projectId: string, write: boolean) => boolean | Promise<boolean>;

/** OpenAI互換と同じ:error:{message,type,code}形。内部詳細（パス・台帳破損のディテール）は出さない。 */
const apiError = (message: string, type: string, code: string) => ({ error: { message, type, code } });

/** 业务例外code → HTTP状態のマップ。秘密・パス・内部構造を漏らさない定型メッセージへ寄せる。 */
function errorStatus(code: string): { status: number; type: string } {
  switch (code) {
    case 'invalid_project_id': case 'invalid_title': case 'invalid_url': case 'invalid_content':
    case 'invalid_query': case 'invalid_revision': case 'invalid_search_mode': case 'invalid_collection':
      return { status: 400, type: 'validation_error' };
    case 'collection_forbidden': return { status: 403, type: 'permission_error' };
    case 'index_building': case 'embedding_not_configured': case 'embedding_failed': case 'model_unavailable': return { status: 503, type: 'server_error' };
    case 'model_response_failed': return { status: 502, type: 'server_error' };
    case 'unsupported_source': return { status: 422, type: 'validation_error' };
    case 'index_too_large': return { status: 413, type: 'request_too_large' };
    case 'not_found': return { status: 404, type: 'not_found_error' };
    case 'revision_conflict': return { status: 409, type: 'conflict_error' };
    case 'content_too_large': case 'query_too_long': return { status: 413, type: 'request_too_large' };
    case 'ledger_corrupted': return { status: 500, type: 'server_error' };
    default: return { status: 500, type: 'server_error' };
  }
}

/** 登録/更新ボディの上限（content の文字数上限に対し、JSON化・日本語UTF-8・エスケープ分の余裕を持つ）。 */
const BODY_LIMIT_BYTES = 2_000_000;

export interface ProjectKnowledgeRouteOptions {
  workspace?:Omit<KnowledgeWorkspaceOptions,'authorize'>;
  collectionIdentity?:(req:FastifyRequest)=>string|undefined;
  authorizeJob?:(projectId:string,ownerId:string)=>Promise<boolean>;
  embedder?: KnowledgeEmbedder;
  readPage?: KnowledgePageReader;
  /** 保存root。未指定なら環境変数→本機設定目录（既定）。試験は mkdtemp ルートを必ず渡す。 */
  root?: string;
  /** ストア差し替え口（試験・複数ストア運用用）。指定時は root を無視する。 */
  store?: ProjectKnowledgeStore;
}

/** ルート登録本体。server.ts からは `registerProjectKnowledgeRoutes(app, authorize)` で呼ぶ。 */
export function registerProjectKnowledgeRoutes(app: FastifyInstance, authorize: ProjectKnowledgeAuthorizer, options: ProjectKnowledgeRouteOptions = {}) {
  const store = options.store || new ProjectKnowledgeStore({ root: options.root, embedder: options.embedder ?? configuredKnowledgeEmbedder() });
  const jobsRoot=path.join(store.root,'collection-jobs');
  let jobs:Promise<KnowledgeCollectionJobs>|undefined;
  const getJobs=()=>{if(!options.authorizeJob)throw new Error('定期収集の認可が未設定です。');return jobs??=KnowledgeCollectionJobs.open(jobsRoot,store,options.authorizeJob,options.readPage).then(service=>{service.start();return service})};
  app.addHook('onReady',async()=>{if(options.authorizeJob){try{await access(path.join(jobsRoot,'jobs.sqlite'))}catch{return}await getJobs()}});
  app.addHook('onClose',async()=>{if(jobs)await(await jobs).close()});
  app.addHook('preHandler',async(req,reply)=>{if(req.url.startsWith('/v1/project-knowledge/')&&!['GET','HEAD','OPTIONS'].includes(req.method)&&(req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&req.headers.origin!==`${req.protocol}://${req.headers.host}`))return reply.code(403).send(apiError('同一オリジンから操作してください。','permission_error','origin_forbidden'))});
  const workspace=registerKnowledgeWorkspace(app,store,{authorize,...options.workspace});
  const routeConfig = { bodyLimit: BODY_LIMIT_BYTES };

  /** 全経路共通の関門: ①projectId規則検証 → ②authorize 必須呼び出し。通過できなければ true。 */
  const guard = async (req: FastifyRequest, reply: FastifyReply, projectId: string, write: boolean): Promise<boolean> => {
    // URLデコード済み値がここに入る。`..%2F` 経由でもパターンを通らないため脱出しない。
    if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
      await reply.code(400).send(apiError('プロジェクトIDは2〜64文字の英小文字・数字・ハイフン・アンダースコア（英数字始まり）で指定してください。', 'validation_error', 'invalid_project_id'));
      return false;
    }
    let allowed = false;
    try { allowed = await authorize(req, reply, projectId, write) === true; }
    catch { allowed = false; } // fail-closed: 権限判定の例外は拒否として扱う
    if (!allowed && !reply.sent) await reply.code(403).send(apiError('このプロジェクトの資料へアクセスする権限がありません。', 'permission_error', write ? 'knowledge_write_forbidden' : 'knowledge_read_forbidden'));
    return allowed;
  };

  /** ストア呼び出し共通の例外→HTTP変換。KnowledgeError 以外は内部情報を隠す定型文へ寄せる。 */
  const handle = async <T>(reply: FastifyReply, work: () => Promise<T>, okStatus?: number): Promise<T | FastifyReply> => {
    try {
      const result = await work();
      return okStatus ? reply.code(okStatus).send(result) : result;
    } catch (error) {
      if(reply.sent)return reply;
      if (error instanceof KnowledgeError) {
        const { status, type } = errorStatus(error.code);
        // 台帳破損など内部事情の読めるcodeは、メッセージも定型へ置換して漏洩面を絞る
        const message = error.code === 'ledger_corrupted' ? '資料台帳を一時的に利用できません。管理者へ伝えてください。' : error.message;
        return reply.code(status).send(apiError(message, type, error.code));
      }
      return reply.code(500).send(apiError('資料の処理に失敗しました。時間を置いて再試行してください。', 'server_error', 'knowledge_internal_error'));
    }
  };

  /** 一覧（read）。`GET /v1/project-knowledge/:projectId/documents` */
  app.get('/v1/project-knowledge/:projectId/documents', routeConfig, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    if (!await guard(req, reply, projectId, false)) return reply;
    return handle(reply, () => store.list(projectId));
  });

  /** 引用元取得（read）。`GET /v1/project-knowledge/:projectId/documents/:documentId` */
  app.get('/v1/project-knowledge/:projectId/documents/:documentId', routeConfig, async (req, reply) => {
    const { projectId, documentId } = req.params as { projectId: string; documentId: string };
    if (!await guard(req, reply, projectId, false)) return reply;
    return handle(reply, () => store.get(projectId, documentId));
  });

  /** 資料登録（write）。`POST /v1/project-knowledge/:projectId/documents` */
  app.post('/v1/project-knowledge/:projectId/documents', routeConfig, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    if (!await guard(req, reply, projectId, true)) return reply;
    const body = (req.body || {}) as { title?: unknown; url?: unknown; content?: unknown };
    return handle(reply, () => store.register(projectId, { title: body.title, url: body.url, content: body.content }), 201);
  });

  /** 資料更新（write）。楽観的ロック expectedRevision 対応。`PUT /v1/project-knowledge/:projectId/documents/:documentId` */
  app.put('/v1/project-knowledge/:projectId/documents/:documentId', routeConfig, async (req, reply) => {
    const { projectId, documentId } = req.params as { projectId: string; documentId: string };
    if (!await guard(req, reply, projectId, true)) return reply;
    const body = (req.body || {}) as { title?: unknown; url?: unknown; content?: unknown; expectedRevision?: unknown };
    return handle(reply, () => store.update(projectId, documentId, body));
  });

  /** 資料削除（write）。`DELETE /v1/project-knowledge/:projectId/documents/:documentId` */
  app.delete('/v1/project-knowledge/:projectId/documents/:documentId', routeConfig, async (req, reply) => {
    const { projectId, documentId } = req.params as { projectId: string; documentId: string };
    if (!await guard(req, reply, projectId, true)) return reply;
    return handle(reply, () => store.remove(projectId, documentId));
  });

  /** 字句検索（read）。クエリ長はストア側でも検証するが、413より先に400で返すためここで先に確認する。 */
  app.get('/v1/project-knowledge/:projectId/search', routeConfig, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    if (!await guard(req, reply, projectId, false)) return reply;
    const query = req.query as { q?: unknown; limit?: unknown; mode?: unknown };
    const q = typeof query.q === 'string' ? query.q : '';
    if (q.length > MAX_QUERY_CHARS) return reply.code(413).send(apiError(`検索文字列は${MAX_QUERY_CHARS}文字以内にしてください。`, 'request_too_large', 'query_too_long'));
    const parsedLimit = query.limit === undefined ? 8 : Number(query.limit);
    const limit = Number.isInteger(parsedLimit) && parsedLimit >= 1 ? Math.min(parsedLimit, MAX_SEARCH_LIMIT) : 8;
    return handle(reply, () => store.search(projectId, q, limit, (query.mode ?? 'auto') as 'auto' | 'lexical' | 'vector' | 'hybrid'));
  });

  /** 公開URLの本文収集。本人の編集権限を取得前と保存前にも検査します。 */
  app.post('/v1/project-knowledge/:projectId/collect', routeConfig, async(req,reply)=>{
    const {projectId}=req.params as {projectId:string};
    if(req.headers.origin&&req.headers.origin!==`${req.protocol}://${req.headers.host}`||req.headers['sec-fetch-site']==='cross-site')return reply.code(403).send(apiError('同一オリジンから操作してください。','permission_error','origin_forbidden'));
    if(!await guard(req,reply,projectId,true))return reply;
    return handle(reply,()=>collectProjectUrls(store,projectId,req.body,async()=>{
      try{return await authorize(req,reply,projectId,true)===true}catch{return false}
    },options.readPage));
  });

  app.get('/v1/project-knowledge/:projectId/sources',routeConfig,async(req,reply)=>{
    const {projectId}=req.params as {projectId:string};if(!await guard(req,reply,projectId,false))return reply;
    return handle(reply,async()=>({sources:(await knowledgeProfiles()).filter(p=>p.projects.includes(projectId)).map(p=>({id:p.id}))}));
  });
  app.get('/v1/project-knowledge/:projectId/collection-jobs',routeConfig,async(req,reply)=>{
    const {projectId}=req.params as {projectId:string};if(!await guard(req,reply,projectId,false))return reply;
    if(!options.authorizeJob)return {jobs:[]};
    return handle(reply,async()=>({jobs:(await getJobs()).list(projectId)}));
  });
  app.post('/v1/project-knowledge/:projectId/collection-jobs',routeConfig,async(req,reply)=>{
    const {projectId}=req.params as {projectId:string};if(!await guard(req,reply,projectId,true))return reply;
    const owner=options.collectionIdentity?.(req);if(!owner||!options.authorizeJob||!await options.authorizeJob(projectId,owner))return reply.code(403).send(apiError('収集ジョブを管理する権限がありません。','permission_error','collection_forbidden'));
    return handle(reply,async()=>{
      const input=req.body as any;
      if(input?.profileId&&!(await knowledgeProfiles()).some(p=>p.id===input.profileId&&p.projects.includes(projectId)))throw new KnowledgeError('この接続設定を利用できません。','collection_forbidden');
      try{return(await getJobs()).create(projectId,owner,input)}catch(error){if(error instanceof KnowledgeError)throw error;throw new KnowledgeError('収集ジョブのURL・間隔・バッチ件数を確認してください。','invalid_collection')}
    },201);
  });
  app.post('/v1/project-knowledge/:projectId/collection-jobs/:jobId/:action',routeConfig,async(req,reply)=>{
    const {projectId,jobId,action}=req.params as {projectId:string;jobId:string;action:string};if(!await guard(req,reply,projectId,true))return reply;
    if(!['pause','resume','delete'].includes(action))return reply.code(400).send(apiError('収集操作が不正です。','validation_error','invalid_collection'));
    return handle(reply,async()=>{(await getJobs()).action(projectId,jobId,action as 'pause'|'resume'|'delete');return{ok:true}});
  });

  app.get('/v1/project-knowledge/:projectId/capabilities',routeConfig,async(req,reply)=>{
    const {projectId}=req.params as {projectId:string};if(!await guard(req,reply,projectId,false))return reply;
    return {vectorEnabled:store.vectorEnabled,searchModes:store.vectorEnabled?['auto','lexical','vector','hybrid']:['auto','lexical'],urlCollection:true,maxPages:10,renderedPages:true,fileExtraction:['pdf','image','audio','video','docx','xlsx','text'],persistentJobs:Boolean(options.authorizeJob)};
  });

  /** 本文上限の事前ガード（JSON parse後の content 文字数確認はストア validateContent が担当。
   *  bodyLimit 超過は Fastify が 413 を返すため、ここで追加処理は不要）。MAX_CONTENT_CHARS は文書参照用に exported。 */
  void MAX_CONTENT_CHARS;
  return{store,...workspace};
}
