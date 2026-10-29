import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { confluencePageId, fetchConfluencePage } from './confluence-research.js';

export interface WebResearch { context: string; sources: string[]; retrievedAt: string; }
/** 調査の種類と検索引数はLLMが判断し、実行層はこの構造化要求だけを処理します。 */
export interface ResearchRequest { kind: 'weather' | 'exchange' | 'search' | 'page'; location?: string; currencies?: [string, string]; query?: string; }
type FetchLike = typeof fetch;
const execFileAsync = promisify(execFile);

/** Windows環境のシステムProxy設定を利用できるcurlでHTTPS JSONを取得します。 */
async function systemWebFetch(input: string | URL | Request): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const result = await execFileAsync('curl.exe', ['--fail', '--silent', '--show-error', '--max-time', '15', url], { windowsHide: true, maxBuffer: 1024 * 1024 });
  return new Response(result.stdout, { status: 200, headers: { 'content-type': 'application/json' } });
}

const weatherLabels: Record<number, string> = { 0: '快晴', 1: '晴れ', 2: '一部曇り', 3: '曇り', 45: '霧', 48: '着氷性の霧', 51: '弱い霧雨', 53: '霧雨', 55: '強い霧雨', 61: '弱い雨', 63: '雨', 65: '強い雨', 71: '弱い雪', 73: '雪', 75: '強い雪', 80: '弱いにわか雨', 81: 'にわか雨', 82: '強いにわか雨', 95: '雷雨' };

/** 日本語の質問から地名候補を抽出し、住所全体と末尾の町名を検索候補にします。 */
export function locationCandidates(prompt: string): string[] {
  // 呼出し元から渡された地名だけを利用し、質問文から言語依存の地名推測を行いません。
  return prompt.trim() ? [prompt.trim()] : [];
}

async function weatherResearch(prompt: string, fetcher: FetchLike): Promise<WebResearch | undefined> {
  let place: any;
  for (const candidate of locationCandidates(prompt)) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(candidate)}&count=1&language=ja&format=json`;
    const response = await fetcher(url, { signal: AbortSignal.timeout(5000) });
    if (response.ok) place = ((await response.json()) as any).results?.[0];
    if (place) break;
  }
  if (!place) return undefined;
  const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m&forecast_days=3&timezone=auto`;
  const response = await fetcher(forecastUrl, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) return undefined;
  const payload = await response.json() as any; const current = payload.current;
  if(!current||typeof current.time!=='string')return undefined;
  // 時間帯の解釈はAIに任せ、現在値と区別した時刻付き予報をそのまま渡します。
  const hourly=Array.isArray(payload.hourly?.time)?payload.hourly.time.slice(0,72).map((time:string,index:number)=>JSON.stringify({time,temperature_2m:payload.hourly.temperature_2m?.[index],precipitation_probability:payload.hourly.precipitation_probability?.[index],weather_code:payload.hourly.weather_code?.[index],wind_speed_10m:payload.hourly.wind_speed_10m?.[index]})).join('\n'):'';
  const placeName = [place.admin1, place.admin2, place.name].filter(Boolean).join(' ');
  return { retrievedAt: new Date().toISOString(), sources: [forecastUrl, 'https://open-meteo.com/'], context: `Open-Meteo実測・予報データ\n場所: ${placeName}\n現在値の時刻: ${current.time} (${payload.timezone})\n天気: ${weatherLabels[current.weather_code] || `コード${current.weather_code}`}\n気温: ${current.temperature_2m} °C\n湿度: ${current.relative_humidity_2m} %\n降水量: ${current.precipitation} mm\n風速: ${current.wind_speed_10m} km/h${hourly?`\n時間別予報（現地時刻、temperature_2m=°C、precipitation_probability=%、wind_speed_10m=km/h）:\n${hourly}`:'\n時間別予報は取得できていません。現在値を午後など将来の予報として扱わないでください。'}` };
}

async function instantWebResearch(prompt: string, fetcher: FetchLike): Promise<WebResearch | undefined> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(prompt)}&format=json&no_html=1&skip_disambig=1`;
  const response = await fetcher(url, { signal: AbortSignal.timeout(5000) }); if (!response.ok) return undefined;
  const payload = await response.json() as any; const text = payload.AbstractText || payload.Answer;
  if (!text) return undefined;
  return { retrievedAt: new Date().toISOString(), sources: [payload.AbstractURL || url].filter(Boolean), context: `Web検索結果\n${text}` };
}

/** 為替質問から通貨ペアを抽出し、よくあるJPN表記を正式コードJPYへ補正します。 */
export function currencyPair(prompt: string): [string, string] | undefined {
  const normalized = prompt.toUpperCase().replace(/JPN/g, 'JPY');
  const explicit = normalized.match(/\b([A-Z]{3})\s*[\/／-]\s*([A-Z]{3})\b/);
  if (explicit) return [explicit[1], explicit[2]];
  return undefined;
}

async function exchangeResearch(prompt: string, fetcher: FetchLike): Promise<WebResearch | undefined> {
  const pair = currencyPair(prompt); if (!pair) return undefined;
  const [base, quote] = pair;
  const url = `https://api.frankfurter.dev/v1/latest?base=${base}&symbols=${quote}`;
  const response = await fetcher(url); if (!response.ok) return undefined;
  const payload = await response.json() as any; const rate = payload.rates?.[quote];
  if (typeof rate !== 'number') return undefined;
  return { retrievedAt: new Date().toISOString(), sources: [url, 'https://frankfurter.dev/'], context: `Frankfurter為替参照データ\n通貨ペア: ${base}/${quote}\n基準日: ${payload.date}\n1 ${base} = ${rate} ${quote}\n注意: 中央銀行等の参照レートに基づく最新営業日データであり、リアルタイム取引価格ではありません。` };
}

/** 質問内容に応じてリアルタイム気象またはWeb検索コンテキストを取得します。 */
export async function retrieveWebResearch(prompt: string, forceWeb = false, fetcher: FetchLike = systemWebFetch as FetchLike, request?: ResearchRequest): Promise<WebResearch | undefined> {
  const confluenceId = confluencePageId(prompt);
  if (confluenceId) {
    const page = await fetchConfluencePage(confluenceId);
    return { retrievedAt: new Date().toISOString(), sources: [page.url], context: `認証済みConfluenceページ\nタイトル: ${page.title}\n本文:\n${page.body}` };
  }
  try {
    if (request?.kind === 'weather') return await weatherResearch(request.location || '', fetcher);
    if (request?.kind === 'exchange') return await exchangeResearch((request.currencies || []).join('/'), fetcher);
    if (request?.kind === 'search' || forceWeb) return await instantWebResearch(request?.query || prompt, fetcher);
  } catch { /* Web障害時はAgent本体を停止せず、検索なしへ安全に縮退します。 */ }
  return undefined;
}
