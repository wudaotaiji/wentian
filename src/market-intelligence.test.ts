import assert from 'node:assert/strict';
import test from 'node:test';
import type { FetchLike } from './market-intelligence.js';
import { MARKET_SOURCES, cachedMarketSignals, clearMarketCache, collectMarketIntelligence, collectMarketSource, extractOpenRouterApps, normalizeMarketKey } from './market-intelligence.js';

/**
 * 市場情報（Market Intelligence）収集の試験です。
 *
 * 約束:
 *  - 実ネットワークへ絶対に触れません。通信はすべて偽fetch（模擬取得）へ差し替えます。
 *  - 1源の失敗が画面全体を壊さないこと、状態（ok/partial/failed/skipped/cached）が正直に出ることを固定します。
 *  - 進程内キャッシュは試験間で共有されるため、各試験の最初に必ず `clearMarketCache()` します。
 */

/** 偽fetchの応答形（`error` を渡すと通信失敗として振る舞います）。 */
interface FakeReply { ok?: boolean; status?: number; json?: unknown; text?: string; error?: string }

/** 通信を差し替え、発行されたURL・オプションを記録する偽fetchを作ります。 */
function fakeFetch(respond: (url: string, init?: Record<string, unknown>) => FakeReply): { fetchImpl: FetchLike; calls: { url: string; init?: Record<string, unknown> }[] } {
  const calls: { url: string; init?: Record<string, unknown> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const reply = respond(url, init);
    if (reply.error) throw new Error(reply.error);
    const status = reply.status ?? (reply.ok === false ? 500 : 200);
    return { ok: reply.ok ?? status === 200, status, json: async () => reply.json ?? {}, text: async () => reply.text ?? '' };
  };
  return { fetchImpl, calls };
}

/**
 * OpenRouter /apps の実測形を模した1行を作ります。
 * 実物ではNext.jsのシリアライズで引用符が `\"` にescapeされているため、JSONを組み立てた後に全引用符を伏せます。
 */
function openRouterRow(appId: number, title: string, slug: string, tokens: number, rank: number, extra: string): string {
  const body = `"title":"${title}","slug":"${slug}"${extra ? `,${extra}` : ''}`;
  return `{"app_id":${appId},"total_tokens":"${tokens}","total_requests":10,"rank":${rank},"app":{${body}}}`.replace(/"/g, '\\"');
}

test('市場情報取得が無効のとき、5源すべて skipped で返り通信を一切発行しない', async () => {
  clearMarketCache();
  const { fetchImpl, calls } = fakeFetch(() => ({ json: {} }));
  const result = await collectMarketIntelligence('npm_downloads', { fetchImpl, enabled: false });
  assert.deepEqual(calls, [], '無効時にHTTPを発行してはいけません');
  assert.equal(result.selectedSource, 'npm_downloads');
  assert.equal(result.signals.length, 0);
  assert.equal(result.sources.length, MARKET_SOURCES.length, '選択源以外も含め5源の状態を必ず載せます');
  assert.deepEqual(result.sources.map(source => source.state), ['skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
  assert.equal(result.sources.find(source => source.id === 'npm_downloads')?.error, '市場情報の取得は無効です。');
  assert.equal(result.sources.find(source => source.id === 'github_stars')?.error, '未取得', '未実測の源は「未取得」と明示します');
});

test('slugは当社のID規則へ寄せる（大文字・記号・長すぎ・空の扱い）', () => {
  assert.equal(normalizeMarketKey('Claude Code'), 'claude-code');
  assert.equal(normalizeMarketKey('NousResearch/hermes-agent'), 'nousresearch-hermes-agent');
  assert.equal(normalizeMarketKey('__Open-Claw__'), 'open-claw');
  assert.equal(normalizeMarketKey('!!!'), 'unknown', '空文字候補にはしません（ID欠落で一覧が落ちるのを防ぎます）');
  assert.equal(normalizeMarketKey('x'.repeat(80)).length, 40, '判定キーは40文字で打ち切ります');
});

test('OpenRouter Appsは期間違い行を合算し、Tokens合計順に上位だけを返す', () => {
  const longDescription = '説'.repeat(220);
  const html = [
    // 合算の検証: 同じ app_id が期間違いで2行（651億 + 300億）、最良rank（2）を採用します。
    openRouterRow(101, 'Claude Code', 'claude-code', 65_100_000_000, 4, `"description":"${longDescription}","source_code_url":"https://github.com/anthropics/claude-code"`),
    openRouterRow(101, 'Claude Code', 'claude-code', 30_000_000_000, 2, ''),
    openRouterRow(102, 'Codex', 'codex', 80_000_000_000, 1, '"description":"OpenAI公式CLI"'),
    openRouterRow(103, 'Ghost', 'ghost', 900_000_000, 9, ''),
    // 名称欠落と Tokens 0 は候補から落ちます（0件を「人気0」と出さない）。
    openRouterRow(104, '', 'nameless', 500_000_000, 5, ''),
    openRouterRow(105, 'Zero', 'zero', 0, 6, ''),
  ].join('<script>self.__next_f.push([1,');
  const signals = extractOpenRouterApps(html, 10);
  assert.deepEqual(signals.map(signal => signal.name), ['Claude Code', 'Codex', 'Ghost'], 'Tokens合計順に並びます');
  assert.equal(signals[0].value, 95_100_000_000, '同じアプリの Tokens は合計します');
  assert.equal(signals[0].key, 'claude-code');
  assert.equal(signals[0].repository, 'anthropics/claude-code', '公式リポジトリは source_code_url から取り出します');
  assert.equal(signals[1].repository, undefined, '取れない行では undefined のままにします');
  assert.equal(signals[1].url, 'https://openrouter.ai/apps?slug=codex', '人が手で確認できるURLを添えます');
  assert.equal(signals[2].note, 'rank 9', '説明が無い行は rank を補足にします');
  assert.ok(String(signals[0].note).endsWith('…') && String(signals[0].note).length === 201, '長い説明は200文字＋省略記号');
  assert.equal(extractOpenRouterApps(html, 2).length, 2, '上位件数で打ち切ります');
  assert.equal(extractOpenRouterApps(html, 0).length, 1, '指定外（0以下）は1件まで');
  assert.equal(extractOpenRouterApps(html, 999).length, 3, '上限50件超過は50件に寄せ、実測3件どおり');
  assert.deepEqual(extractOpenRouterApps(''), [], 'HTMLが空でも例外にしません');
});

test('GitHub Starsは候補ごとに並列取得し、個別失敗はその候補だけ欠落させる', async () => {
  clearMarketCache();
  const repositories = [
    { key: 'claude', name: 'Claude Code', repository: 'anthropics/claude-code' },
    { key: 'codex', name: 'Codex', repository: 'openai/codex' },
  ];
  const { fetchImpl, calls } = fakeFetch(url => (url.includes('openai/codex') ? { ok: false, status: 403 } : { json: { stargazers_count: 41200 } }));
  const result = await collectMarketSource('github_stars', { fetchImpl, repositories });
  assert.equal(result.report.state, 'partial', '1件でも欠ければ部分取得。全滅でなければ失敗にはしません');
  assert.deepEqual(result.signals, [{ key: 'claude', name: 'Claude Code', value: 41200, repository: 'anthropics/claude-code', url: 'https://github.com/anthropics/claude-code' }]);
  assert.equal(calls.length, 2, '候補ぶんを並列に取ります');
  assert.ok(calls[0].url.startsWith('https://api.github.com/repos/'));
  assert.equal((calls[0].init?.headers as Record<string, string>).accept, 'application/vnd.github+json');
  assert.equal((calls[0].init?.headers as Record<string, string>)['user-agent'], 'wentian-control-center');
  assert.ok(calls[0].init?.signal instanceof AbortSignal, '取得には必ず経過時間上限を付けます');
});

test('Star源の状態は「渡された候補数のうち取れた件数」で決まり、候補が減っても化けない', async () => {
  clearMarketCache();
  const { fetchImpl } = fakeFetch(() => ({ json: { stargazers_count: 7 } }));
  const single = await collectMarketSource('github_stars', { fetchImpl, repositories: [{ key: 'kilo', name: 'Kilo', repository: 'Kilo-Org/kilo' }] });
  assert.equal(single.report.state, 'ok', '1候補だけなら1件取得で ok（maxItems 12に引きずられません）');
  assert.equal(single.report.itemCount, 1);
  clearMarketCache();
  const none = await collectMarketSource('github_stars', { fetchImpl, repositories: [] });
  assert.equal(none.report.state, 'failed', '1件も取れない源を成功にしません');
  assert.equal(none.report.error, '候補を取得できませんでした。');
});

test('npmは計測できる候補数が元々少なくても全件成功で ok にする', async () => {
  clearMarketCache();
  const { fetchImpl, calls } = fakeFetch(url => ({ json: { downloads: url.endsWith('/cline') ? 900 : 100 } }));
  const result = await collectMarketSource('npm_downloads', { fetchImpl });
  assert.equal(calls.length, 6, 'npm配布が確認済みの6候補だけを取ります');
  assert.equal(result.report.state, 'ok', 'maxItems（10）で判定すると全件成功でも partial が残り、状態行が誤誘導します');
  assert.equal(result.signals[0].key, 'cline', '実測値順に並びます');
  assert.equal(result.signals[0].value, 900);
  assert.ok(result.signals.every(signal => signal.url?.startsWith('https://www.npmjs.com/package/')));
});

test('PyPIは限速（429）を候補欠落として許容し、残った件数を返す', async () => {
  clearMarketCache();
  const { fetchImpl, calls } = fakeFetch(url => (url.includes('hermes-agent') ? { ok: false, status: 429 } : { json: { data: { last_week: 51000 } } }));
  const result = await collectMarketSource('pypi_downloads', { fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(result.report.state, 'partial', '期待2件のうち1件なので部分取得');
  assert.deepEqual(result.signals.map(signal => signal.key), ['aider']);
  assert.equal(result.signals[0].repository, 'Aider-AI/aider');
});

test('VS Code Marketplaceは公式extensionqueryをPOSTし、曖昧一致した別拡張を捨てます', async () => {
  clearMarketCache();
  const reply = (publisher: string, name: string, install: number) => ({
    json: { results: [{ extensions: [
      { publisher: { publisherName: 'someone-else' }, extensionName: 'claude-dev', displayName: '紛れ込み', statistics: [{ statisticName: 'install', value: 999_999 }] },
      { publisher: { publisherName: publisher }, extensionName: name, displayName: 'Cline', statistics: [{ statisticName: 'install', value: install }, { statisticName: 'rating', value: 4.9 }] },
    ] }] },
  });
  // 公式extensionqueryはURLが常に同じで、検索語はPOST本文へ入ります（URLではなく本文で応答を分けます）。
  const { fetchImpl, calls } = fakeFetch((_url, init) => (String(init?.body).includes('Continue.continue') ? reply('Continue', 'continue', 40_000) : reply('saoudrizwan', 'claude-dev', 1_200_000)));
  const result = await collectMarketSource('vscode_installs', { fetchImpl });
  assert.equal(result.report.state, 'ok');
  assert.deepEqual(result.signals.map(signal => [signal.key, signal.value]), [['cline', 1_200_000], ['continue', 40_000]]);
  assert.equal(calls.length, 2, '応答が大きいため1拡張ずつ取ります');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal((calls[0].init?.headers as Record<string, string>).accept, 'application/json;api-version=3.0-preview.1');
  const body = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(body.filters[0].criteria, [{ filterType: 7, value: 'saoudrizwan.claude-dev' }]);
  assert.equal(body.filters[0].flags, 91, '内側のflagsは検索用（実測確定値）');
  assert.equal(body.flags, 347, '外側のflagsに統計ビット（256）が含まれないと install が返りません');
});

test('既定6時間キャッシュは発行を止め、clearMarketCacheとTTL超過で取り直しが確認できる', async () => {
  clearMarketCache();
  const clock = { at: Date.parse('2026-10-03T00:00:00.000Z') };
  const repositories = [{ key: 'claude', name: 'Claude Code', repository: 'anthropics/claude-code' }];
  const withClock = (stars: number) => {
    const fake = fakeFetch(() => ({ json: { stargazers_count: stars } }));
    return { fake, fetchImpl: fake.fetchImpl, now: () => clock.at, expectedItems: 1, repositories };
  };
  const okOnce = await collectMarketSource('github_stars', withClock(1000));
  assert.equal(okOnce.report.state, 'ok');
  assert.equal(okOnce.report.fetchedAt, '2026-10-03T00:00:00.000Z');
  // 5時間59分59秒後: まだキャッシュ。2回目の通信は発行しません。
  clock.at += 6 * 60 * 60 * 1000 - 1000;
  const second = withClock(2000);
  const cacheHit = await collectMarketSource('github_stars', second);
  assert.equal(cacheHit.report.state, 'cached');
  assert.equal(second.fake.calls.length, 0, 'キャッシュ命中時に実取得がありません');
  assert.deepEqual(cachedMarketSignals('github_stars').map(signal => signal.value), [1000], 'HTTPを出さずにキャッシュ値だけ引けます');
  // キャッシュを落とすと、その時点で初めて取り直します（手動更新・設定変更用）。
  clearMarketCache('github_stars');
  assert.deepEqual(cachedMarketSignals('github_stars'), []);
  const refreshed = await collectMarketSource('github_stars', second);
  assert.equal(refreshed.report.state, 'ok');
  assert.equal(second.fake.calls.length, 1, '破棄後は1件だけ取り直します');
  assert.equal(refreshed.signals[0].value, 2000);
  // TTL超過（既定6時間超）も自動で取り直します。
  clock.at += 6 * 60 * 60 * 1000 + 1000;
  const third = withClock(3000);
  const expired = await collectMarketSource('github_stars', third);
  assert.equal(expired.report.state, 'ok');
  assert.equal(third.fake.calls.length, 1);
  assert.equal((third.fake.calls[0].init?.headers as Record<string, string>)['user-agent'], 'wentian-control-center', '取り直しでも同じ出典ヘッダーを使います');
});

test('取得失敗でも前回実測値を使い続け、状態と誤りだけで古さを伝える（出典URLは伏字）', async () => {
  clearMarketCache();
  const clock = { at: Date.parse('2026-10-03T00:00:00.000Z') };
  const seeded = fakeFetch(() => ({ text: openRouterRow(201, 'Cline', 'cline', 700_000_000, 3, '"description":"VS Code拡張"') }));
  const first = await collectMarketSource('openrouter_apps', { fetchImpl: seeded.fetchImpl, now: () => clock.at, expectedItems: 1 });
  assert.equal(first.report.state, 'ok');
  clock.at += 7 * 60 * 60 * 1000;
  // 通信失敗（DNS・限速・仕様変更など）を模擬します。誤り文にURLが混じってもそのまま出しません。
  const broken = fakeFetch(() => ({ error: 'fetch failed https://openrouter.ai/apps' }));
  const failed = await collectMarketSource('openrouter_apps', { fetchImpl: broken.fetchImpl, now: () => clock.at, expectedItems: 1 });
  assert.equal(failed.report.state, 'failed');
  assert.equal(failed.report.itemCount, 1, '前回実測の件数を残します');
  assert.deepEqual(failed.signals.map(signal => signal.key), ['cline'], '一覧を空にするより「古い実測」を正直に出します');
  assert.equal(failed.report.fetchedAt, '2026-10-03T00:00:00.000Z', '元の実測日時をそのまま出します');
  assert.ok(failed.report.error && !failed.report.error.includes('openrouter.ai'), '誤りに出典URLを含めません');
  assert.ok(failed.report.error?.includes('URL'), 'URLは伏字にして形だけ残します');
});

test('選択源だけを実測に取り、他の4源はキャッシュ状態か「未取得」で軽く返す', async () => {
  clearMarketCache();
  const { fetchImpl, calls } = fakeFetch(url => ({ json: { downloads: 1234 } }));
  const result = await collectMarketIntelligence('npm_downloads', { fetchImpl, expectedItems: 1 });
  assert.equal(calls.length, 6, '10秒ごとの制御盤更新で5源ぶんを毎回声にさせません');
  assert.ok(calls.every(call => call.url.includes('api.npmjs.org')));
  assert.equal(result.selectedSource, 'npm_downloads');
  assert.equal(result.sources.find(source => source.id === 'npm_downloads')?.state, 'ok');
  assert.deepEqual(result.sources.filter(source => source.id !== 'npm_downloads').map(source => source.state), ['skipped', 'skipped', 'skipped', 'skipped']);
  // 選択しなかった源は実測しないので「未取得」が正しい表示です（Star状態は別の経路で埋めます）。
  assert.equal(result.sources.find(source => source.id === 'github_stars')?.error, '未取得');
  // 一度実測した源は、選択源から外れてもキャッシュ状態として見えます。
  const pypi = fakeFetch(() => ({ json: { data: { last_week: 1 } } }));
  const switched = await collectMarketIntelligence('pypi_downloads', { fetchImpl: pypi.fetchImpl, expectedItems: 1 });
  assert.equal(switched.sources.find(source => source.id === 'npm_downloads')?.state, 'cached');
  assert.equal(switched.sources.find(source => source.id === 'npm_downloads')?.itemCount, 6);
  assert.equal(switched.selectedSource, 'pypi_downloads');
  assert.ok(pypi.calls.every(call => call.url.includes('pypistats.org')), '切り替え後は新しい選択源だけを取ります');
});

test('5源の定義は画面の選択リストとして必要な項目を揃えている', () => {
  assert.deepEqual(MARKET_SOURCES.map(source => source.id), ['github_stars', 'openrouter_apps', 'npm_downloads', 'pypi_downloads', 'vscode_installs']);
  assert.deepEqual(MARKET_SOURCES.filter(source => source.officialApi === false).map(source => source.id), ['openrouter_apps'], '公式APIが無い源は画面で明示します');
  for (const source of MARKET_SOURCES) {
    assert.ok(source.label, `${source.id} の表示名が必要です`);
    assert.ok(source.homepage.startsWith('https://'), `${source.id} の出典が確認できません`);
    assert.ok(source.metric && source.note, `${source.id} の実測値の意味・注記が必要です`);
    assert.ok(source.expected >= 1 && source.expected <= source.maxItems, `${source.id} の期待件数は計測範囲内です`);
  }
});
