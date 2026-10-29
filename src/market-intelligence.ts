/**
 * 市場情報（Market Intelligence）収集モジュール
 *
 * 目的:
 *  「智能体市场」の一覧を GitHub Star だけの一極判断から離し、5つの別々の市場実測値から候補を並べ替える。
 *  ただし外部HTTPは失敗・限速・仕様変更が常态なので、1つの源の失敗が画面全体を壊さない作りを原則にする。
 *
 * 設計の約束:
 *  1. 各源は必ず `MarketSourceReport`（状態・取得日時・件数・誤り）を残す。黙って空にならない。
 *  2. fetch（取得関数）は注入可能にする。単体試験が実ネットワークへ触れないため必须。
 *  3. 秘密情報（APIキー・トークン）は要求しない。すべて匿名で取得できる公開実測値だけを使う。
 *  4. 数値は「人気度の参考」であって、導入可否・実行可否の判断材料にはしない（導入は別途plan+承認）。
 */

/** 対応する市場情報源（Market Source）の識別子。画面の選択リストとAPI引数で共通に使う。 */
export type MarketSourceId = 'github_stars' | 'openrouter_apps' | 'npm_downloads' | 'pypi_downloads' | 'vscode_installs';

/** 1源の取得状態。`partial` は一部項目だけ取れた場合（限速・名称欠落など）に使う。 */
export type MarketSourceState = 'ok' | 'partial' | 'failed' | 'skipped' | 'cached';

/** 市場から得た1候補の実測値。ここで確定した `key` は catalog の id に揃う。未対応候補は市場側のslugを使う。 */
export interface MarketSignal {
  /** 候補の判定キー（AGENT_CATALOG の id に揃う既定値） */
  key: string;
  /** 市場側で観測した表示名 */
  name: string;
  /** 実測値（Stars・週間インストール数・週間DL・総Tokens） */
  value: number;
  /** 公式リポジトリ（owner/repository）。取れない源では undefined。 */
  repository?: string;
  /** 出典URL（人が手で確認できるURL） */
  url?: string;
  /** 補足（カテゴリ・評価など、翻訳しない実測テキスト） */
  note?: string;
}

/** 1源の運用状態。画面の「市場情報 状態」行とAPIの `sources` にそのまま載せる。 */
export interface MarketSourceReport {
  id: MarketSourceId;
  /** 画面表示用の固有名（翻訳せず源の固有名を出す。UI側で辞書キーにもなる） */
  label: string;
  /** 出典サイトの homepage（人が検証できる場所） */
  homepage: string;
  /** 公式APIか。false の場合はページ埋め込みの読み取り（仕様変更で壊れ得る）であることを画面で明示する。 */
  officialApi: boolean;
  /** 数値が表す意味（例: Stars / 週間インストール数） */
  metric: string;
  /** 状態 */
  state: MarketSourceState;
  /** 取得できた候補数 */
  itemCount: number;
  /** 実測の取得日時（キャッシュ時は元の実測日時） */
  fetchedAt: string | null;
  /** 誤り概要（秘密値・応答本文は载せない） */
  error: string | null;
  /** 適用範囲の注記（例: npm配布の候補のみ） */
  note: string;
}

/** 収集結果（1源ぶん）。 */
export interface MarketSourceResult {
  report: MarketSourceReport;
  signals: MarketSignal[];
}

/** 試験で偽実装を注入できるよう、最小の fetch 形だけを要求する。 */
export type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>;
}>;

export interface MarketCollectionOptions {
  /** 取得関数（既定は globalThis.fetch）。試験は固定JSONを返す偽関数を渡す。 */
  fetchImpl?: FetchLike;
  /** 現在時刻（試験の固定時計用） */
  now?: () => number;
  /** キャッシュ有効期間（既定 6時間）。外部実測は10秒ごとに取り直さない。 */
  ttlMs?: number;
  /** 個別HTTPの上限秒（既定 8秒） */
  timeoutSeconds?: number;
  /** false のとき全源を `skipped` で返し、実HTTPを一切発行しない（オフライン運用・試験用）。 */
  enabled?: boolean;
  /** ok 判定に使う期待候補数。省略時は源の maxItems（=計測可能な候補総数）を使う。 */
  expectedItems?: number;
}

/** 源の定義（取得関数は後で束ねる）。画面の源一覧・既定源の決定にも使うので公開します。 */
export interface SourceDefinition {
  id: MarketSourceId;
  label: string;
  homepage: string;
  officialApi: boolean;
  metric: string;
  note: string;
  /** この源で計測できる候補数の上限（応答が大きい源は件数を絞る） */
  maxItems: number;
  /** ok 判定に使う期待候補数（この源で本来取れるはずの候補数） */
  expected: number;
}

/** npm配布名（実測で200確認済みの名称だけを書く）。 */
const NPM_PACKAGES: { key: string; pkg: string }[] = [
  { key: 'claude', pkg: '@anthropic-ai/claude-code' },
  { key: 'openclaw', pkg: 'openclaw' },
  { key: 'opencode', pkg: 'opencode-ai' },
  { key: 'gemini', pkg: '@google/gemini-cli' },
  { key: 'cline', pkg: 'cline' },
  { key: 'kilo', pkg: '@kilocode/cli' },
];

/** PyPI配布名（pypistats recent が200で返ることを実測確認済み）。 */
const PYPI_PACKAGES: { key: string; pkg: string; repository: string }[] = [
  { key: 'aider', pkg: 'aider-chat', repository: 'Aider-AI/aider' },
  { key: 'hermes', pkg: 'hermes-agent', repository: 'NousResearch/hermes-agent' },
];

/** VS Code拡張（応答サイズと取得時間のため、確認済みの最小集合だけを対象にする）。 */
const VSCODE_EXTENSIONS: { key: string; extension: string; name: string; repository: string }[] = [
  { key: 'cline', extension: 'saoudrizwan.claude-dev', name: 'Cline', repository: 'cline/cline' },
  { key: 'continue', extension: 'Continue.continue', name: 'Continue', repository: 'continuedev/continue' },
];

export const MARKET_SOURCES: SourceDefinition[] = [
  { id: 'github_stars', label: 'GitHub Stars', homepage: 'https://github.com', officialApi: true, metric: 'Star数', note: '公式REST。登録済み全候補をカバーします。', maxItems: 12, expected: 12 },
  { id: 'openrouter_apps', label: 'OpenRouter Apps', homepage: 'https://openrouter.ai/apps', officialApi: false, metric: '週間Tokens', note: 'OpenRouterにエージェント ranked APIは無いため、/apps の実測値を読み取ります。', maxItems: 10, expected: 10 },
  { id: 'npm_downloads', label: 'npm', homepage: 'https://www.npmjs.com', officialApi: true, metric: '週間インストール数', note: 'npm配布がある候補のみ計測できます。', maxItems: 10, expected: NPM_PACKAGES.length },
  { id: 'pypi_downloads', label: 'PyPI', homepage: 'https://pypistats.org', officialApi: true, metric: '週間ダウンロード数', note: 'Python配布の候補のみ。pypistatsは短時間に繰り返すと429を返します。', maxItems: 10, expected: PYPI_PACKAGES.length },
  { id: 'vscode_installs', label: 'VS Code Marketplace', homepage: 'https://marketplace.visualstudio.com', officialApi: true, metric: 'インストール数', note: 'IDE拡張として配布される候補のみ。応答が大きいため少数項目だけ項目別に取得します。', maxItems: 3, expected: VSCODE_EXTENSIONS.length },
];

/** 源別キャッシュ（進程内）。value は実測時刻とSignals。 */
const sourceCache = new Map<MarketSourceId, { at: number; signals: MarketSignal[] }>();

/** 試験・運用の両方でキャッシュを落とせるようにする（設定変更・手動更新用）。 */
export function clearMarketCache(sourceId?: MarketSourceId): void {
  if (sourceId) sourceCache.delete(sourceId); else sourceCache.clear();
}

/**
 * キャッシュ済みの実測値だけを返す（HTTPを発行しない）。
 * 画面の【添加】を押されたとき、一覧を出した直後の実測値を再取得せずに引くために使います。
 */
export function cachedMarketSignals(sourceId: MarketSourceId): MarketSignal[] {
  return sourceCache.get(sourceId)?.signals ?? [];
}

/** 文字列化しても秘密値が漏れないよう、応答本文を含まず記号・数値だけ残して短く丸める。 */
function briefError(error: unknown, status?: number): string {
  const base = error instanceof Error ? error.message : String(error ?? '');
  const head = base.split(/\r?\n/)[0].replace(/https?:\/\/\S+/g, 'URL').slice(0, 160);
  return status ? `HTTP ${status}${head ? `: ${head}` : ''}` : (head || '取得失敗');
}

/** GitHub の `owner/repository` URLから判定キーへ使う表記を取り出す。 */
function repositoryFromUrl(value: unknown): string | undefined {
  const text = String(value ?? '');
  const match = text.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  return match ? match[1].replace(/\.git$/, '') : undefined;
}

/** slug（市場側のID）を当社のID規則（小文字英数字・ハイフン）へ寄せる。空文字にはしない。 */
export function normalizeMarketKey(slug: string): string {
  const folded = String(slug || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return folded || 'unknown';
}

/**
 * OpenRouter `/apps` のHTMLへ埋め込まれたランキングレコードを読む純粋関数。
 *
 * 実測で確認できた形（2026-10-03）:
 *   {\"app_id\":123,\"total_tokens\":\"65102000000\",\"total_requests\":456,\"rank\":2,\"app\":{\"title\":\"...\",\"slug\":\"...\",\"source_code_url\":\"...\",\"description\":\"...\"}}
 * Next.js のシリアライズで引用符が `\"` にescapeされているため、先に1段ほど戻してから読みます。
 * 同じアプリが期間違いで複数行になるため、app_id単位で Tokens を合計し、最良（最小）rankを採用します。
 */
export function extractOpenRouterApps(html: string, limit = 10): MarketSignal[] {
  const text = String(html || '').replace(/\\"/g, '"');
  const totals = new Map<number, { tokens: number; rank: number; title: string; slug: string; repository?: string; description: string }>();
  for (const match of text.matchAll(/\{"app_id":(\d+),"total_tokens":"(\d+)","total_requests":(\d+),"rank":(\d+),"app":\{([\s\S]*?)\}\}/g)) {
    const appId = Number(match[1]);
    const tokens = Number(match[2]);
    const rank = Number(match[4]);
    const body = match[5] || '';
    const field = (name: string) => (body.match(new RegExp(`"${name}":"([^"]*)"`)) || [])[1] || '';
    const current = totals.get(appId);
    if (!current) {
      totals.set(appId, { tokens, rank, title: field('title'), slug: field('slug'), repository: repositoryFromUrl(field('source_code_url')), description: field('description') });
    } else {
      current.tokens += tokens;
      current.rank = Math.min(current.rank, rank);
    }
  }
  return [...totals.values()]
    .filter(value => value.title && Number.isFinite(value.tokens) && value.tokens > 0)
    // tokens は実測値そのもの。同じ値のときは公式リポジトリを持つ側を先にして、後の行の判定を安定させる。
    .sort((a, b) => b.tokens - a.tokens || a.rank - b.rank || a.title.localeCompare(b.title))
    .slice(0, Math.max(1, Math.min(50, limit)))
    .map(value => ({
      // AGENT_CATALOG との対応付けは agent-marketplace 側で行うため、ここでは市場側のslugを保持する。
      key: normalizeMarketKey(value.slug),
      name: value.title.slice(0, 80),
      value: value.tokens,
      repository: value.repository,
      url: `https://openrouter.ai/apps?slug=${encodeURIComponent(value.slug || '')}`,
      note: `${value.description.slice(0, 200)}${value.description.length > 200 ? '…' : ''}` || `rank ${value.rank}`,
    }));
}

/** 源1つの取得を共通の失敗処理・キャッシュ・件数上限で包む。 */
async function collect(
  definition: SourceDefinition,
  options: MarketCollectionOptions,
  load: (fetchImpl: FetchLike, timeoutMs: number) => Promise<MarketSignal[]>,
): Promise<MarketSourceResult> {
  const now = options.now ? options.now() : Date.now();
  const ttl = options.ttlMs ?? 6 * 60 * 60 * 1000;
  const base: MarketSourceReport = {
    id: definition.id, label: definition.label, homepage: definition.homepage, officialApi: definition.officialApi,
    metric: definition.metric, state: 'ok', itemCount: 0, fetchedAt: null, error: null, note: definition.note,
  };
  if (options.enabled === false) return { report: { ...base, state: 'skipped', error: '市場情報の取得は無効です。' }, signals: [] };
  const cached = sourceCache.get(definition.id);
  if (cached && now - cached.at < ttl) {
    return { report: { ...base, state: 'cached', itemCount: cached.signals.length, fetchedAt: new Date(cached.at).toISOString() }, signals: cached.signals };
  }
  const fetchImpl = options.fetchImpl || (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof fetchImpl !== 'function') return { report: { ...base, state: 'failed', error: 'fetchを利用できません。' }, signals: [] };
  try {
    const timeoutMs = (options.timeoutSeconds ?? 8) * 1000;
    const signals = (await load(fetchImpl, timeoutMs))
      .filter(signal => Number.isFinite(signal.value) && signal.value >= 0 && signal.key)
      .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
      .slice(0, definition.maxItems);
    // 1件も取れない源を「成功」にしない（空の一覧を人気度なしと誤読させない）。
    // 対象候補のうち何割取れたかで ok / partial を分け、maxItems の調整で状態が化けないようにする。
    // ok 判定の期待件数は `expected`（本来取れるはずの候補数）を正とします。
    // maxItems（応答サイズ調整用の切り上限）をそのまま使うと、npm・PyPI・VS Codeは
    // 計測できる候補数が元々少ないため、全件成功でも永遠に `partial` が残り、状態行が誤誘導します。
    const expected = Math.max(1, options.expectedItems ?? definition.expected ?? definition.maxItems);
    const state: MarketSourceState = signals.length >= expected ? 'ok' : signals.length ? 'partial' : 'failed';
    sourceCache.set(definition.id, { at: now, signals });
    return {
      report: {
        ...base, state, itemCount: signals.length, fetchedAt: new Date(now).toISOString(),
        error: signals.length ? (state === 'partial' ? '一部の候補のみ取得できました。' : null) : '候補を取得できませんでした。',
      },
      signals,
    };
  } catch (error) {
    // 失敗時も前回成功値があれば使い続け、状態だけで「古さ」を伝える。
    const stale = sourceCache.get(definition.id);
    return {
      report: { ...base, state: 'failed', itemCount: stale?.signals.length ?? 0, fetchedAt: stale ? new Date(stale.at).toISOString() : null, error: briefError(error) },
      signals: stale?.signals ?? [],
    };
  }
}

/** JSON/テキスト取得を共通化（ AbortSignal.timeout（経過時間で自動中止）が使えるNode前提 ）。 */
async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(briefError(undefined, response.status));
  return response.json();
}

/** GitHub Star（公式REST）。登録済み全候補を並列で取り、個別失敗はその候補だけ欠落させる。 */
async function fetchGitHubStars(fetchImpl: FetchLike, timeoutMs: number, repositories: { key: string; name: string; repository: string }[]): Promise<MarketSignal[]> {
  const settled = await Promise.all(repositories.map(async item => {
    try {
      const body = await getJson(fetchImpl, `https://api.github.com/repos/${item.repository}`, timeoutMs, { accept: 'application/vnd.github+json', 'user-agent': 'wentian-control-center' }) as { stargazers_count?: number };
      const stars = Number(body?.stargazers_count);
      return Number.isFinite(stars) ? [{ key: item.key, name: item.name, value: stars, repository: item.repository, url: `https://github.com/${item.repository}` }] : [];
    } catch { return []; /* 1リポジトリの失敗で源全体を落とさない */ }
  }));
  return settled.flat();
}

/** OpenRouter Apps（ページ埋め込み）。公式APIが無いため、実測HTMLから読み取る。 */
async function fetchOpenRouterApps(fetchImpl: FetchLike, timeoutMs: number, limit: number): Promise<MarketSignal[]> {
  const response = await fetchImpl('https://openrouter.ai/apps', { headers: { accept: 'text/html', 'user-agent': 'wentian-control-center' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(briefError(undefined, response.status));
  return extractOpenRouterApps(await response.text(), limit);
}

/** npm 週間インストール数（公式ダウンロードAPI）。 */
async function fetchNpmDownloads(fetchImpl: FetchLike, timeoutMs: number): Promise<MarketSignal[]> {
  const settled = await Promise.all(NPM_PACKAGES.map(async item => {
    try {
      const body = await getJson(fetchImpl, `https://api.npmjs.org/downloads/point/last-week/${item.pkg}`, timeoutMs) as { downloads?: number };
      const downloads = Number(body?.downloads);
      return Number.isFinite(downloads) ? [{ key: item.key, name: item.pkg, value: downloads, url: `https://www.npmjs.com/package/${item.pkg}` }] : [];
    } catch { return []; }
  }));
  return settled.flat();
}

/** PyPI 週間ダウンロード数（pypistats）。限速（429）が常態なので、項目別失敗は欠落として許容する。 */
async function fetchPypiDownloads(fetchImpl: FetchLike, timeoutMs: number): Promise<MarketSignal[]> {
  const signals: MarketSignal[] = [];
  for (const item of PYPI_PACKAGES) {
    try {
      const body = await getJson(fetchImpl, `https://pypistats.org/api/packages/${item.pkg}/recent`, timeoutMs) as { data?: { last_week?: number } };
      const downloads = Number(body?.data?.last_week);
      if (Number.isFinite(downloads)) signals.push({ key: item.key, name: item.pkg, value: downloads, repository: item.repository, url: `https://pypi.org/project/${item.pkg}/` });
    } catch { /* 429・名称欠落は次の候補へ */ }
  }
  return signals;
}

/**
 * VS Code Marketplace インストール数（公式 extensionquery）。
 * 1項目の応答が約1.7MBと大きいため、候補を最小集合に絞り、並列を出して混雑させず項目別に取ります。
 * 統計は flags に 256（統計を含む）を要求しないと返らないことを実測で確認済みです（flags 347）。
 */
async function fetchVscodeInstalls(fetchImpl: FetchLike, timeoutMs: number): Promise<MarketSignal[]> {
  const signals: MarketSignal[] = [];
  for (const item of VSCODE_EXTENSIONS) {
    try {
      // POST本文の検索語（filterType 7 = 名前検索）に `publisher.name` を入れるのが公式の確定取得手順です。
      const response = await fetchImpl('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json;api-version=3.0-preview.1' },
        body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: item.extension }], flags: 91 }], flags: 347 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;
      const parsed = await response.json() as { results?: { extensions?: {
        publisher?: { publisherName?: string }; extensionName?: string; displayName?: string;
        statistics?: { statisticName: string; value: number }[];
      }[] }[] };
      // 検索語は曖昧一致するため、`publisher/extensionName` が要求と完全一致する行だけを採用します。
      const [wantPublisher, wantName] = item.extension.split('.');
      for (const extension of parsed?.results?.[0]?.extensions ?? []) {
        const publisher = String(extension.publisher?.publisherName || '');
        const name = String(extension.extensionName || '');
        if (publisher.toLowerCase() !== wantPublisher.toLowerCase() || name.toLowerCase() !== wantName.toLowerCase()) continue;
        const install = Number((extension.statistics ?? []).find(statistic => statistic.statisticName === 'install')?.value);
        if (Number.isFinite(install)) signals.push({ key: item.key, name: String(extension.displayName || item.name).slice(0, 80), value: install, repository: item.repository, url: `https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(item.extension)}` });
      }
    } catch { /* 1拡張の失敗で源を落とさない */ }
  }
  return signals;
}

/** 選択した1源を実測し、状態付きで返す。 */
export async function collectMarketSource(sourceId: MarketSourceId, options: MarketCollectionOptions & { repositories?: { key: string; name: string; repository: string }[] } = {}): Promise<MarketSourceResult> {
  const definition = MARKET_SOURCES.find(source => source.id === sourceId) || MARKET_SOURCES[0];
  switch (definition.id) {
    case 'github_stars': {
      // Star源は「渡された候補のうち何件取れたか」で状態を決める（候補数が減っても ok が保たれる）。
      const starOptions = { ...options, expectedItems: options.expectedItems ?? Math.max(1, options.repositories?.length ?? definition.maxItems) };
      return collect(definition, starOptions, (fetchImpl, timeout) => fetchGitHubStars(fetchImpl, timeout, options.repositories ?? []));
    }
    case 'openrouter_apps': return collect(definition, options, (fetchImpl, timeout) => fetchOpenRouterApps(fetchImpl, timeout, definition.maxItems));
    case 'npm_downloads': return collect(definition, options, (fetchImpl, timeout) => fetchNpmDownloads(fetchImpl, timeout));
    case 'pypi_downloads': return collect(definition, options, (fetchImpl, timeout) => fetchPypiDownloads(fetchImpl, timeout));
    case 'vscode_installs': return collect(definition, options, (fetchImpl, timeout) => fetchVscodeInstalls(fetchImpl, timeout));
  }
}

/** 選択源の実測値と、全源の状態（状態行だけ必要とする画面ために軽く揃える）。 */
export interface MarketIntelligence {
  generatedAt: string;
  selectedSource: MarketSourceId;
  /** 全源の状態（取得順は MARKET_SOURCES に揃う） */
  sources: MarketSourceReport[];
  /** 選択源の実測ランキング */
  signals: MarketSignal[];
}

/**
 * 市場情報の収集。既定では選択源だけを実測に取り、他の源はキャッシュ（未取得なら skipped 相当）で状態を返します。
 * 10秒ごとの制御盤更新で5源ぶんを毎回声にさせることはありません。
 */
export async function collectMarketIntelligence(selectedSource: MarketSourceId, options: MarketCollectionOptions & { repositories?: { key: string; name: string; repository: string }[] } = {}): Promise<MarketIntelligence> {
  const selected = await collectMarketSource(selectedSource, options);
  const sources: MarketSourceReport[] = [];
  for (const definition of MARKET_SOURCES) {
    if (definition.id === selected.report.id) { sources.push(selected.report); continue; }
    // 未実測の源は、キャッシュがあるときだけその状態を載せ、無ければ「未取得」として明示する。
    const cached = sourceCache.get(definition.id);
    sources.push(cached
      ? { id: definition.id, label: definition.label, homepage: definition.homepage, officialApi: definition.officialApi, metric: definition.metric, state: 'cached', itemCount: cached.signals.length, fetchedAt: new Date(cached.at).toISOString(), error: null, note: definition.note }
      : { id: definition.id, label: definition.label, homepage: definition.homepage, officialApi: definition.officialApi, metric: definition.metric, state: 'skipped', itemCount: 0, fetchedAt: null, error: '未取得', note: definition.note });
  }
  return { generatedAt: new Date(options.now ? options.now() : Date.now()).toISOString(), selectedSource: selected.report.id, sources, signals: selected.signals };
}
