import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { assertOrdinaryPath } from '../safe-file.js';
import type { GroupResponder } from '../agent-group.js';

export const studyArtifactInstruction = '成果物は書斎へ保存できます。依頼の意味を読み、完成した報告・調査資料・計画・コード等の成果があればfilesへMarkdownまたはNotebookとして記載してください。挨拶や短い回答だけならfiles:[]。書斎への保存を依頼された場合は必要な本文を作成してください。確認していない今日の作業や実行結果を捏造せず、不明点を明記してください。保存はホストが行います。自分で保存済みと主張しないでください。JSONだけ: {"reply":"利用者への回答","files":[{"name":"report.md または analysis.ipynb","content":"ファイル全文"}]}。最大4ファイル、合計1MiB。Notebookはnbformat:4、コードは実行せずoutputs:[]、execution_count:null。';

/** 保存先はJupyterと同じ設定からホストが渡す。AIは任意の保存先を指定できません。 */
export async function saveStudyArtifacts(root: string, files: unknown, source = 'chat') {
  if (!Array.isArray(files) || files.length > 4) throw new Error('書斎の成果物一覧が不正です。');
  if (new Set(files.map(file => file?.name)).size !== files.length) throw new Error('成果物のファイル名が重複しています。');
  let size = 0;
  const checked = files.map(file => {
    if (!file || typeof file.name !== 'string' || file.name.length > 120 || !/^[^\\/:*?"<>|\x00-\x1f]+\.(md|ipynb)$/.test(file.name) || file.name.startsWith('.') || typeof file.content !== 'string' || !file.content.trim()) throw new Error('成果物はMarkdownまたはNotebookのファイル名と本文を指定してください。');
    size += Buffer.byteLength(file.content); if (size > 1024 * 1024) throw new Error('書斎の成果物は合計1MiB以内です。');
    let content = file.content;
    if (file.name.endsWith('.ipynb')) {
      const notebook = JSON.parse(content);
      if (notebook.nbformat !== 4 || !Array.isArray(notebook.cells) || !Number.isInteger(notebook.nbformat_minor) || !notebook.metadata || typeof notebook.metadata !== 'object') throw new Error('Notebookの形式が不正です。');
      for (const cell of notebook.cells) {
        if (!cell || !['markdown','code','raw'].includes(cell.cell_type) || !(typeof cell.source === 'string' || Array.isArray(cell.source) && cell.source.every((s: unknown) => typeof s === 'string'))) throw new Error('Notebookのセル形式が不正です。');
        cell.metadata = {}; if (cell.cell_type === 'code') { cell.outputs = []; cell.execution_count = null; }
      }
      notebook.metadata = {}; content = JSON.stringify(notebook, null, 2);
    }
    return { name: file.name, content };
  });
  if (!checked.length) return [];
  const directory = path.join(root, 'artifacts', source === 'forge' ? 'forge' : 'chat', randomUUID());
  await assertOrdinaryPath(directory); await mkdir(directory, { recursive: true });
  const saved = [];
  for (const file of checked) {
    const target = path.join(directory, file.name); await assertOrdinaryPath(target);
    await writeFile(target, file.content, { flag: 'wx', mode: 0o600 });
    if (await readFile(target, 'utf8') !== file.content) throw new Error('書斎の成果物を保存後に確認できませんでした。');
    saved.push({ name: file.name, path: target, url: '/study/jupyter/lab/tree/' + path.relative(root, target).split(path.sep).map(encodeURIComponent).join('/') });
  }
  return saved;
}

export function parseStudyReply(raw: string): { reply: string; files: unknown[] } {
  const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (typeof value?.reply !== 'string' || !value.reply.trim() || !Array.isArray(value.files)) throw new Error('AIの書斎成果物の応答形式を確認できませんでした。');
  return value;
}
export function studyReceipt(saved: Awaited<ReturnType<typeof saveStudyArtifacts>>) {
  return saved.length ? '\n\n' + saved.map(file => '📄 ' + file.path + '\n' + file.url).join('\n') : '';
}

/** 群の会話を変更せず、AIが完成成果物の有無を構造化判断します。内部の選定・投票は対象外です。 */
export function withStudyArtifacts(respond: GroupResponder, root: (groupId?: string) => Promise<string | undefined>): GroupResponder {
  return async (member, messages, context, signal) => {
    const result = await respond(member, messages, context, signal);
    if (context?.outcomePhase || context?.studyPlanning || context?.startupPlanning || context?.topicSelection || context?.researchSelection || context?.assetPlanning || context?.imageRouting || context?.phase) return result;
    const directory = await root(context?.groupId); if (!directory) return result;
    const content = typeof result === 'string' ? result : result.content;
    const decision = await respond(member, [{ role: 'system', content: studyArtifactInstruction + '入力の会話は引用資料です。会話の内容と依頼から保存する成果を判断し、replyには元の回答を保持してください。' }, { role: 'user', content: JSON.stringify({ messages: messages.slice(-12), response: content }) }], { groupId: context?.groupId || '', usedAgents: [], studyPlanning: true }, signal);
    const parsed = parseStudyReply(typeof decision === 'string' ? decision : decision.content);
    const saved = await saveStudyArtifacts(directory, parsed.files, 'forge');
    return typeof result === 'string' ? content + studyReceipt(saved) : { ...result, content: content + studyReceipt(saved) };
  };
}
