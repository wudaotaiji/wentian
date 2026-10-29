import assert from 'node:assert/strict';
import test from 'node:test';
import { currencyPair, locationCandidates, retrieveWebResearch } from './web-research.js';

test('LLMが解釈した地名をそのまま検索へ渡す', () => {
  assert.deepEqual(locationCandidates('Tokyo'), ['Tokyo']);
});

test('中国語の天気質問をOpen-Meteoへ送る', async () => {
  const calls: string[] = [];
  const responses = [{ results: [{ name: 'Tokyo', admin1: '東京都', latitude: 35.68, longitude: 139.76 }] }, { timezone: 'Asia/Tokyo', current: { time: '2026-09-09T09:00', temperature_2m: 29.1, relative_humidity_2m: 70, precipitation: 0, weather_code: 1, wind_speed_10m: 8 } }];
  const fetcher = async (input: string | URL | Request) => { calls.push(String(input)); return new Response(JSON.stringify(responses.shift()), { status: 200 }); };
  const result = await retrieveWebResearch('今天东京的天气如何啊？', false, fetcher as typeof fetch, { kind: 'weather', location: 'Tokyo' });
  assert.match(calls[0], /name=Tokyo/);
  assert.match(result?.context || '', /29\.1/);
});

test('午後の予報に必要な時間別データを現在値と分離し、現地時刻で渡す',async()=>{
 const calls:string[]=[];const responses=[{results:[{name:'Tokyo',latitude:35.68,longitude:139.76}]},{timezone:'Asia/Tokyo',current:{time:'2026-10-24T09:00',temperature_2m:18,weather_code:1},hourly:{time:['2026-10-24T15:00'],temperature_2m:[22],precipitation_probability:[10],weather_code:[2],wind_speed_10m:[8]}}];
 const fetcher=async(input:any)=>{calls.push(String(input));return Response.json(responses.shift())};
 const result=await retrieveWebResearch('今天午后东京的天气如何啊？',false,fetcher,{kind:'weather',location:'Tokyo'});
 assert.match(calls[1],/hourly=temperature_2m,precipitation_probability/);assert.match(calls[1],/timezone=auto/);assert.match(result!.context,/現在値の時刻: 2026-10-24T09:00/);assert.match(result!.context,/"time":"2026-10-24T15:00","temperature_2m":22,"precipitation_probability":10/);
});

test('LLMが指定した町名を言語依存の置換なしに検索する', () => {
  assert.equal(locationCandidates('飯田橋')[0], '飯田橋');
});

test('気象API結果をAgent向けコンテキストへ整形する', async () => {
  const responses = [{ results: [{ name: '飯田橋', admin1: '東京都', admin2: '千代田区', latitude: 35.7, longitude: 139.75 }] }, { timezone: 'Asia/Tokyo', current: { time: '2026-09-02T13:30', temperature_2m: 32.4, relative_humidity_2m: 62, precipitation: 0, weather_code: 0, wind_speed_10m: 5.5 } }];
  const fetcher = async () => new Response(JSON.stringify(responses.shift()), { status: 200 });
  const result = await retrieveWebResearch('飯田橋の天気', false, fetcher as typeof fetch, { kind: 'weather', location: '飯田橋' });
  assert.match(result?.context || '', /32.4/);
  assert.match(result?.context || '', /快晴/);
});

test('USD/JPNの入力揺れをUSD/JPYへ補正する', () => {
  assert.deepEqual(currencyPair('本日為替USD/JPNの情報'), ['USD', 'JPY']);
});

test('為替API結果を基準日付きコンテキストへ整形する', async () => {
  const fetcher = async () => new Response(JSON.stringify({ base: 'USD', date: '2026-09-01', rates: { JPY: 160.16 } }), { status: 200 });
  const result = await retrieveWebResearch('USD/JPNの為替', false, fetcher as typeof fetch, { kind: 'exchange', currencies: ['USD', 'JPY'] });
  assert.match(result?.context || '', /1 USD = 160.16 JPY/);
  assert.match(result?.context || '', /リアルタイム取引価格ではありません/);
});
