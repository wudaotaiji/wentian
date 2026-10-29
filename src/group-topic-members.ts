import type { GroupMember, GroupResponder } from './agent-group.js';
import { loadAgentSelectionConfig } from './agent-selection.js';
import type { VisualAsset } from './visual-assets.js';

/**
 * 主題の専門役はLLMに選定させます。コードは人数・名前・役割の形式だけを検証します。
 * 失敗を固定の専門役で覆い隠さず、理由を呼出し元へ返します。モデル指定は操作者の選択を保持します。
 */
export async function topicMembers(title: string, model = 'wentian-agent/auto', respond?: GroupResponder, assets: VisualAsset[] = []): Promise<GroupMember[]> {
  if (!respond) throw new Error('専門メンバー選定用のLLM接続がありません。');
  const result = await respond({ name: '専門メンバー選定', role: '主題の文脈から必要な専門家を選ぶ。', model }, [
    { role: 'system', content: '主題全体を読み、議論に必要な専門家を1～12人選んでください。分野名のキーワード一致で決めず、目的と制約に合う役割を選んでください。JSONだけを返してください。形式: {"members":[{"name":"担当名","role":"具体的な役割"}]}。nameは40文字以内、roleは2000文字以内。同名を重複させないでください。' },
    ...(assets.length ? [{ role: 'system', content: '各メンバーの主題・役割に合う人物素材を選び、各memberにvisualAssetId（候補IDまたはnull）とvisualReason（選択理由または適切な候補がない理由、1000文字以内）を追加してください。名前のキーワード一致や順番ではなく文脈を判断してください。候補以外のIDやURLを作らないでください。適切な素材がなければnull。候補は名称・制作指示だけであり画像を見たとは主張しないでください。候補: ' + JSON.stringify(assets.filter(a => a.kind === 'character').map(a => ({ id: a.id, name: a.name, description: a.prompt?.slice(0, 2000) }))) }] : []),
    { role: 'user', content: title },
  ], { groupId: '', usedAgents: [], topicSelection: true }, AbortSignal.timeout(loadAgentSelectionConfig().planner.timeoutMs));
  const raw = typeof result === 'string' ? result : result.content;
  let parsed: any;
  try { parsed = JSON.parse(raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || raw); }
  catch { throw new Error('LLMが専門メンバーの有効なJSONを返しませんでした。'); }
  if (!Array.isArray(parsed.members) || parsed.members.length < 1 || parsed.members.length > 12) throw new Error('LLMの専門メンバー数が不正です。');
  const names = new Set<string>();
  return parsed.members.map((item: any) => {
    if (typeof item?.name !== 'string' || !item.name.trim() || item.name.trim().length > 40 || typeof item.role !== 'string' || !item.role.trim() || item.role.length > 2000 || names.has(item.name.trim())) throw new Error('LLMの専門メンバー名または役割が不正です。');
    const name = item.name.trim(); names.add(name);
    const asset = assets.find(a => a.kind === 'character' && a.id === item.visualAssetId);
    if (item.visualAssetId != null && !asset) throw new Error('AIが候補にない人物素材を選択しました。');
    if (assets.length && (typeof item.visualReason !== 'string' || !item.visualReason.trim() || item.visualReason.length > 1000)) throw new Error('AIの人物素材選択の根拠を確認できませんでした。');
    return { name, role: item.role.trim(), model, avatar: { type: 'generated', seed: name }, ...(assets.length ? { visual: { assetId: asset?.id ?? null, reason: item.visualReason, ...(asset ? { url: asset.url, ...(asset.sprite !== undefined ? { sprite: asset.sprite } : {}) } : {}) } } : {}) };
  });
}
