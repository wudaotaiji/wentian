import type { ProviderConfig } from './config.js';
import type { GroupResponder } from './agent-group.js';
import { generateVisualImage } from './visual-assets.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentImageAdapter } from './codex-image.js';

export interface ImageCandidate { id: string; provider: string; model: string; adapter: 'images-api' | 'comfyui' | 'codex' }
export interface WentianImageRuntime {
  inspect(signal?: AbortSignal): Promise<{ candidates: ImageCandidate[]; message: string }>;
  generate(prompt: string, signal: AbortSignal): Promise<Buffer>;
}

/** 既存のWentianプロバイダー設定を再利用する画像生成アダプターです。 */
export function createWentianImageRuntime(options: { providers: () => ProviderConfig[]; respond: GroupResponder; comfyEnabled: () => boolean; fetch?: typeof fetch; apiGenerate?: typeof generateVisualImage; codex?: AgentImageAdapter }): WentianImageRuntime {
  const request = options.fetch || fetch;
  const root = (p: ProviderConfig) => p.baseUrl.replace(/\/+$/, '');
  const headers = (p: ProviderConfig): Record<string, string> => p.apiKey ? { authorization: 'Bearer ' + p.apiKey } : {};
  async function json(p: ProviderConfig, suffix: string, signal: AbortSignal, body?: unknown) {
    const r = await request(root(p) + suffix, { signal, redirect: 'error', method: body ? 'POST' : 'GET', headers: { ...headers(p), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!r.ok) throw new Error('画像生成プラグインへの接続に失敗しました（HTTP ' + r.status + '）。');
    return r.json();
  }
  async function discover(signal?: AbortSignal) {
    const providers = options.providers().filter(p => p.enabled && p.kind === 'media');
    const candidates: ImageCandidate[] = [];
    const codex = await options.codex?.inspect(signal).catch(() => undefined);
    if (codex) candidates.push({ id: 'external/codex', provider: 'codex', model: codex.model, adapter: 'codex' });
    await Promise.all(providers.map(async p => {
      // プロバイダー名やモデル名から画像能力を推測しません。宣言または実機のノード情報で確認します。
      if (p.id !== 'comfyui') {
        for (const [model, profile] of Object.entries(p.modelProfiles || {})) if ((profile.capabilities?.image_generation || 0) > 0) candidates.push({ id: p.id + ':' + model, provider: p.id, model, adapter: 'images-api' });
        return;
      }
      if (!options.comfyEnabled()) return;
      try {
        const timeout = AbortSignal.timeout(4000), probe = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const info = await json(p, '/object_info', probe);
        if (!['CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage'].every(n => info[n])) return;
        const names = info.CheckpointLoaderSimple.input?.required?.ckpt_name?.[0];
        if (Array.isArray(names)) for (const model of names.filter((m: unknown) => typeof m === 'string').slice(0, 32)) candidates.push({ id: p.id + ':' + model, provider: p.id, model, adapter: 'comfyui' });
      } catch { /* 未稼働のプラグインは候補へ含めません。 */ }
    }));
    return { candidates: candidates.sort((a, b) => a.id.localeCompare(b.id)), providers };
  }
  return {
    async inspect(signal) { const { candidates } = await discover(signal); return { candidates, message: candidates.length ? 'Wentianが制作時に画像生成プラグインとモデルを選択します。' : 'Wentianに任せるモードです。現在利用可能な画像生成プラグインは確認できません。会話での制作相談は利用できます。' }; },
    async generate(prompt, signal) {
      const { candidates, providers } = await discover(signal);
      if (!candidates.length) throw new Error('Wentianで利用可能な画像生成プラグインがありません。画像生成プラグインの導入・有効化が必要です。制作画面での個別API設定は任意です。');
      const result = await options.respond({ name: '画像制作ルーター', role: '利用可能な画像生成プラグインとモデルの選択', model: 'wentian-agent/auto' }, [
        { role: 'system', content: '制作指示に適した実在候補を一つ選択する。候補外のIDを作らない。形式は {"candidateId":"候補のid","reason":"選択理由"} のJSONだけ。候補: ' + JSON.stringify(candidates) },
        { role: 'user', content: prompt },
      ], { groupId: 'visual-routing', usedAgents: [], imageRouting: true }, signal);
      const d = JSON.parse((typeof result === 'string' ? result : result.content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      const selected = candidates.find(c => c.id === d?.candidateId);
      if (!selected || typeof d.reason !== 'string' || !d.reason.trim()) throw new Error('AIが選んだ画像生成経路を確認できませんでした。');
      if (selected.adapter === 'codex') return options.codex!.generate(prompt, signal);
      const p = providers.find(p => p.id === selected.provider)!;
      if (selected.adapter === 'images-api') return (options.apiGenerate || generateVisualImage)({ endpoint: root(p) + '/images/generations', model: selected.model, apiKey: p.apiKey || '' }, prompt, signal);
      // ノード名・入出力参照はComfyUIプロトコルの固定値です。制作内容はAIの指示を使用します。
      const workflow = {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: selected.model } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
        '4': { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 768, batch_size: 1 } },
        '5': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: Math.floor(Math.random() * 2147483647), steps: 24, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
        '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'wentian-visual' } },
      };
      const job = await json(p, '/prompt', signal, { prompt: workflow });
      if (typeof job.prompt_id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(job.prompt_id)) throw new Error('画像制作ジョブを開始できませんでした。');
      try {
        while (!signal.aborted) {
          const history = await json(p, '/history/' + encodeURIComponent(job.prompt_id), signal), item = history[job.prompt_id];
          if (item?.status?.status_str === 'error') throw new Error('Wentianの画像生成プラグインで制作に失敗しました。');
          const image = item?.outputs?.['7']?.images?.[0];
          if (image) {
            if (typeof image.filename !== 'string' || typeof image.subfolder !== 'string' || !['output', 'temp'].includes(image.type)) throw new Error('画像出力情報が不正です。');
            const r = await request(root(p) + '/view?' + new URLSearchParams(image), { signal, redirect: 'error', headers: headers(p) });
            if (!r.ok) throw new Error('制作した画像を取得できませんでした。');
            const reader = r.body?.getReader(); if (!reader) throw new Error('画像がありません。');
            const chunks: Uint8Array[] = []; let size = 0;
            try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 20 * 1024 ** 2) throw new Error('画像が大きすぎます。'); chunks.push(next.value); } } finally { await reader.cancel(); }
            const bytes = Buffer.concat(chunks); if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PNG画像を取得できませんでした。'); return bytes;
          }
          if (item?.status?.completed) throw new Error('制作完了後の画像がありません。');
          await delay(1000, undefined, { signal });
        }
        throw new Error('画像制作を中断しました。');
      } finally {
        // 他の利用者のジョブを停止する/interruptは呼ばず、このジョブの待機を終了します。
      }
    },
  };
}
