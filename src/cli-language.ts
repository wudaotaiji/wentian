import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { machineConfigDirectory } from './agent-exclusion-policy.js';
import { renameWithRetry } from './atomic-file.js';

export type CliLanguage = 'ja' | 'en' | 'zh';
let selected: CliLanguage | undefined;
let active = false;
export const cliLanguagePath = () => process.env.WENTIAN_CLI_SETTINGS_FILE || path.join(machineConfigDirectory(), 'cli-language.json');
export function isCliLanguage(value: unknown): value is CliLanguage { return value === 'ja' || value === 'en' || value === 'zh'; }
/** 表示言語は明示設定だけから選び、依頼文のキーワードや文字種では判定しません。 */
export function configuredCliLanguage(): CliLanguage | undefined {
  if (selected) return selected;
  if (isCliLanguage(process.env.WENTIAN_CLI_LANGUAGE)) return process.env.WENTIAN_CLI_LANGUAGE;
  try { const value = JSON.parse(readFileSync(cliLanguagePath(), 'utf8')).language; return isCliLanguage(value) ? value : undefined; } catch { return undefined; }
}
export function cliLanguage(): CliLanguage { return configuredCliLanguage() || 'ja'; }
/** Webサーバーなど、CLI以外の応答言語へ端末の保存設定を混入させません。 */
export function activeCliLanguage(): CliLanguage | undefined { return active ? configuredCliLanguage() : undefined; }
export function selectCliLanguage(value: string): void {
  if (!isCliLanguage(value)) throw new Error('Language: ja / en / zh');
  selected = value;
}
/** 色設定や会話履歴には触れず、CLIの言語だけを原子的に保存します。 */
export async function saveCliLanguage(value: string): Promise<void> {
  if (!isCliLanguage(value)) throw new Error('Language: ja / en / zh');
  const target = cliLanguagePath(); await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, language: value }) + '\n', { encoding: 'utf8', mode: 0o600 });
  await renameWithRetry(temporary, target); selectCliLanguage(value);
}
/** --以降の依頼文は変更せず、言語オプションを起動時確認より先に適用します。 */
export function configureCliLanguage(args: string[]): string[] {
  active = true;
  const result: string[] = [];
  for (let i=0;i<args.length;i++) {
    if (args[i] === '--') { result.push(...args.slice(i)); break; }
    if (args[i] === '--language') { selectCliLanguage(args[++i] || ''); continue; }
    result.push(args[i]);
  }
  return result;
}

// 辞書はUI専用です。引数、識別子、モデルの回答、ツール出力は翻訳しません。
const entries: [string,string,string][] = [
 ['  wentian security api-key generate [--force]  現在のユーザー用APIキーを生成・再発行','  wentian security api-key generate [--force]  Generate or rotate the current-user API key','  wentian security api-key generate [--force]  生成或轮换当前用户的 API Key'],
 ['次の依頼を編集中 · Esc/Ctrl+C 処理中断 · Enterは完了後に送信','Draft your next request · Esc/Ctrl+C Interrupt · Enter to send when ready','可编辑下个请求 · Esc/Ctrl+C 中断处理 · 处理完成后按 Enter 发送'],
 ['利用可能な候補なし','No available candidates','没有可用候选'],
 ['表示言語: --language ja|en|zh（保存する場合は /language ja|en|zh）','Display language: --language ja|en|zh (save with /language ja|en|zh)','显示语言：--language ja|en|zh（使用 /language ja|en|zh 保存）'],
 ['未対応のスラッシュコマンド（Slash Command）です: /{0}\nEscで候補を閉じて編集できます。','Unsupported slash command: /{0}\nPress Esc to close the suggestions and edit.','不支持的斜杠命令：/{0}\n按 Esc 关闭候选列表后可继续编辑。'],['↑/↓ 選択 · Enter/Tab 挿入 · Esc 取消 ({0}/{1})','↑/↓ Select · Enter/Tab Insert · Esc Cancel ({0}/{1})','↑/↓ 选择 · Enter/Tab 插入 · Esc 取消（{0}/{1}）'],
 ['このセッション','This session','本次会话'],['このセッションを再開するには、次を実行してください:','To resume this session, run:','要恢复此会话，请运行：'],['または wentian resume を実行し、{0} を選択してください。','Or run wentian resume and select {0}.','或运行 wentian resume 并选择 {0}。'],
 ['• 会話接続\n  └ {0} / 経過{1}秒','• Conversation connection\n  └ {0} / Elapsed {1}s','• 连接会话\n  └ {0}／已用 {1}秒'],['会話候補（性能順）: {0}','Conversation candidates (performance order): {0}','会话候选（按性能排序）：{0}'],['外部会話へ接続: {0}','Connecting to external conversation agent: {0}','正在连接外部会话智能体：{0}'],['会話の性能台帳を保存できませんでした。','Could not save conversation performance records.','无法保存会话性能记录。'],
 ['Agent操作を中断しました。','Agent operation cancelled.','已中断智能体操作。'],['Agent応答に失敗しました: {0}','Agent response failed: {0}','智能体响应失败：{0}'],['最終結果: {0}（終了コード: {1}）','Final result: {0} (exit code: {1})','最终结果：{0}（退出码：{1}）'],
 ['画像を添付しました: {0} ({1} KiB)','Image attached: {0} ({1} KiB)','已添加图片：{0}（{1} KiB）'],['クリップボード画像を添付しました: {0} ({1} KiB)','Clipboard image attached: {0} ({1} KiB)','已添加剪贴板图片：{0}（{1} KiB）'],['画像添付に失敗しました: {0}','Failed to attach image: {0}','添加图片失败：{0}'],['添付画像はありません。','No images attached.','尚未添加图片。'],
 ['使用方法: /copy [N]（Nは1以上。1が直前の回答）','Usage: /copy [N] (N >= 1; 1 is the latest answer)','用法：/copy [N]（N不小于1，1表示上次回答）'],['コピーできる回答がまだありません。','No answer is available to copy yet.','暂无可复制的回答。'],['{0}個前の回答はありません。','There is no answer at position {0}.','没有第 {0} 条历史回答。'],['回答をクリップボードへコピーしました: {0}（{1} bytes{2}）','Answer copied to clipboard: {0} ({1} bytes{2})','已将回答复制到剪贴板：{0}（{1} bytes{2}）'],['直前','Latest','上次'],['、上限で省略',', truncated at the limit','，超出上限部分已省略'],
 ['状態','Status','状态'],['学習データ','Training data','训练数据'],['使用方法: /training status | on | off','Usage: /training status | on | off','用法：/training status | on | off'],['ローカル学習データへ伏字化して保存しました。','Saved to local training data with sensitive values redacted.','已对敏感信息脱敏并保存到本地训练数据。'],
 ['Version更新が完了しました。version={0}, commit={1}\nManifest: {2}\nWentian Agentを再起動してください。','Update complete. version={0}, commit={1}\nManifest: {2}\nRestart Wentian Agent.','更新完成。version={0}, commit={1}\nManifest：{2}\n请重启 Wentian Agent。'],['有効な更新計画がありません。先に/updateを実行してください。','No valid update plan. Run /update first.','没有有效更新计划，请先运行 /update。'],['使用方法: /update または /update apply <TOKEN>','Usage: /update or /update apply <TOKEN>','用法：/update 或 /update apply <TOKEN>'],
 ['• Working ({0}s • esc to interrupt)','• Working ({0}s • esc to interrupt)','• 正在处理（{0}秒 · Esc 中断）'],
 ['長期Goalを作成','Create a persistent goal','创建长期目标'],['Goal一覧を表示','List goals','列出目标'],['Goalを現在の端末で実行','Run a goal in this terminal','在当前终端执行目标'],['Goalをバックグラウンドで開始','Start a goal in the background','在后台启动目标'],['GoalとDaemonの状態を表示','Show goal and daemon status','查看目标与守护进程状态'],['Goal Daemonを停止','Stop the goal daemon','停止目标守护进程'],
 ['入力','Input','输入'],['処理','Processing','处理中'],['作業計画','Work plan','工作计划'],['回答','Answer','回答'],['未確認','Unverified','未确认'],['未実行','Not run yet','尚未执行'],['実行情報なし','No execution details','无执行详情'],
 ['メッセージを入力…','Enter a message…','请输入消息…'],['強制優先','Forced priority','强制优先'],['設定モデル','Configured model','配置模型'],['要求モデル','Requested model','请求模型'],['自動選択','Automatic selection','自动选择'],['（全経路へ自動切替）',' (automatically routed to all providers)','（自动切换至全部通道）'],['画像','Images','图片'],['前回','Previous','上次'],
 ['ブルー','Blue','蓝色'],['グレー','Gray','灰色'],['グリーン','Green','绿色'],['パープル','Purple','紫色'],['端末既定','Terminal default','终端默认'],
 ['Wentian · 次の依頼を入力できます','Wentian · Ready for your next request','Wentian · 可以输入下一个请求'],['/status 状態確認 · /theme 配色選択','/status Status · /theme Theme','/status 查看状态 · /theme 选择配色'],
 ['Enter 送信 · Ctrl+J 改行 · ↑↓ 履歴 · / コマンド · Ctrl+C 取消/終了','Enter Send · Ctrl+J New line · ↑↓ History · / Commands · Ctrl+C Cancel/Exit','Enter 发送 · Ctrl+J 换行 · ↑↓ 历史 · / 命令 · Ctrl+C 取消/退出'],
 ['Wentian Agentを起動しました。Enterで送信、Shift/Ctrl+EnterまたはCtrl+Jで改行します。/helpでコマンドを確認できます。','Wentian Agent started. Enter to send; Shift/Ctrl+Enter or Ctrl+J for a new line. Use /help for commands.','Wentian Agent 已启动。Enter 发送，Shift/Ctrl+Enter 或 Ctrl+J 换行。输入 /help 查看命令。'],
 ['Wentian の更新を確認しています…','Checking for Wentian updates…','正在检查 Wentian 更新…'],['Wentian {0} は最新です。','Wentian {0} is up to date.','Wentian {0} 已是最新版本。'],['更新を確認できませんでした。起動を続けます: {0}','Could not check for updates. Continuing startup: {0}','无法检查更新，继续启动：{0}'],
 ['リモート情報なし','No remote information','无远程信息'],['ローカル版がリモートより先行しています。','The local version is ahead of the remote.','本地版本领先于远程版本。'],['Wentian の更新があります: {0} ({1}) → {2}','Wentian update available: {0} ({1}) → {2}','Wentian 有可用更新：{0}（{1}）→ {2}'],
 ['現在は更新できません。','Cannot update at this time.','目前无法更新。'],['更新すると依存関係の復元・検証を行います。完了後に Wentian を再起動してください。','Updating restores and verifies dependencies. Restart Wentian when it finishes.','更新将恢复并验证依赖，完成后请重启 Wentian。'],['Enter で今すぐ更新 / n + Enter で後で: ','Enter to update now / n + Enter to postpone: ','Enter 立即更新／n + Enter 稍后更新：'],['更新を延期しました。後から wentian update で更新できます。','Update postponed. Run wentian update later.','已推迟更新，之后可运行 wentian update。'],
 ['更新完了: {0} ({1})\n記録: {2}\nWentian を再起動してください。','Update complete: {0} ({1})\nRecord: {2}\nRestart Wentian.','更新完成：{0}（{1}）\n记录：{2}\n请重启 Wentian。'],['更新に失敗しました: {0}','Update failed: {0}','更新失败：{0}'],
 ['言語: {0}（/language ja|en|zh で変更・保存）','Language: {0} (change and save with /language ja|en|zh)','语言：{0}（使用 /language ja|en|zh 修改并保存）'],
 ['表示言語と既定の回答言語を選択・保存','Choose and save the UI and default response language','选择并保存界面与默认回答语言'],
 ['現在の接続・モデル・会話・画像・外部Agent待機状態','Show connections, model, conversation, images, and agent readiness','查看连接、模型、对话、图片与外部智能体就绪状态'],['最新版確認と60秒間有効な更新Token発行','Check updates and issue an update token valid for 60 seconds','检查更新并签发60秒有效的更新令牌'],['明示承認した更新を適用・検証・再起動','Apply and verify an explicitly approved update, then restart','应用并验证明确批准的更新，然后重启'],['長期Goalを作成・一覧・実行・確認・停止','Create, list, run, inspect, or stop persistent goals','创建、列出、执行、检查或停止长期目标'],
 ['学習データ蓄積状態を表示','Show training data collection status','查看训练数据收集状态'],['明示的に蓄積を有効化・無効化','Explicitly enable or disable collection','明确启用或禁用数据收集'],['現在のモデル表示、またはモデル変更','Show or change the current model','查看或更改当前模型'],['入力背景を選択・保存（blue/slate/green/purple/none）','Choose and save the input theme (blue/slate/green/purple/none)','选择并保存输入框配色（blue/slate/green/purple/none）'],
 ['直前または指定した過去の回答をクリップボードへコピー','Copy the latest or a specified previous answer to the clipboard','将上次或指定的历史回答复制到剪贴板'],['会話履歴を消去して新しい会話を開始','Clear conversation history and start a new conversation','清除对话历史并开始新对话'],['画像を添付','Attach an image','添加图片'],['クリップボード画像を添付','Attach an image from the clipboard','添加剪贴板图片'],['添付画像を一覧表示','List attached images','列出已添加图片'],['添付画像をすべて解除','Remove all image attachments','移除全部图片附件'],['互換複数行入力を開始','Start legacy multiline input','开始兼容多行输入'],['Slash Command一覧を表示','Show slash commands','显示斜杠命令'],['Wentian Agentを終了','Exit Wentian Agent','退出 Wentian Agent'],
 ['Slash Command（スラッシュコマンド / Slash Command）:','Slash Commands:','斜杠命令：'],['Slash Command 候補（/{0}）:','Slash Command candidates (/{0}):','斜杠命令候选（/{0}）：'],['未対応のSlash Commandです: /{0}\nTabで一覧を再表示、EscまたはCtrl+Cで編集をやり直してください。','Unsupported slash command: /{0}\nPress Tab to show commands, or Esc / Ctrl+C to edit again.','不支持的斜杠命令：/{0}\n按 Tab 重新显示列表，按 Esc 或 Ctrl+C 重新编辑。'],
 ['現在のモデル: {0}','Current model: {0}','当前模型：{0}'],['入力背景: {0}\n','Input theme: {0}\n','输入框配色：{0}\n'],['会話履歴を消去し、新しいSessionを開始しました。','Conversation history cleared. A new session has started.','已清除对话历史并开始新会话。'],['添付画像をすべて解除しました。','All image attachments removed.','已移除全部图片附件。'],
 ['Sessionを再開しました: {0} ({1})','Session resumed: {0} ({1})','已恢复会话：{0}（{1}）'],['タイトルなし','Untitled','无标题'],['• 依頼を解析し、必要なモデルとToolを選択します。','• Analyzing the request and selecting the required model and tools.','• 正在分析请求并选择所需模型与工具。'],
  ['Wentian CLIの実行に失敗しました:','Wentian CLI failed:','Wentian CLI 执行失败：'],
  ['受入設定がないため自動検証は未実施です。変更は反映済みです。反映ファイル: {0}。','Automated verification was skipped because no acceptance settings are configured. Changes were published. Files: {0}.','未配置验收设置，跳过自动验证。更改已反映。文件：{0}。'],
];
entries.push(['音声を録音して下書きへ追加','Record speech and add it to the draft','录制语音并加入草稿']);
entries.push(
 ['通信失敗・時間超過','Connection failed or timed out','连接失败或超时'],
 ['CLI生存確認に失敗','CLI health check failed','CLI 存活检查失败'],
 ['接続未確認・期限切れ','Connection unverified or expired','连接未验证或已过期'],
 ['会話失敗後の再試行待ち','Waiting to retry after a conversation failure','会话失败后等待重试'],
 ['会話コマンド未対応','Conversation command unavailable','不支持会话命令'],
 ['会話応答の形式検証に失敗','Conversation response validation failed','会话回复格式验证失败'],
 ['会話プロセスの実行に失敗','Conversation process failed','会话进程执行失败'],
 ['実行許可が必要（実行権限画面で承認）','Execution permission required (approve on the Execution Permissions page)','需要执行许可（请在执行权限页面批准）'],
 ['実行範囲の設定が必要（Agent画面でプロジェクト範囲・取消状態を確認）','Execution scope needs configuration (check project scope and revocation on the Agents page)','需要设置执行范围（请在代理页面查看项目范围及撤销状态）'],
 ['会話応答を取得できません。操作は開始していません。確認結果: {0}','No conversation response was obtained. No operations were started. Diagnostics: {0}','未能获取会话回复。尚未开始任何操作。诊断结果：{0}'],
);
entries.push(
 ['モデルを選択','Select a model','选择模型'],['外部Agentを選択','Select an external agent','选择外部智能体'],
 ['モデルを一覧から選択、ID指定で直接変更','Select a model from the list or specify its ID','从列表选择模型，也可指定ID切换'],
 ['設定で除外されています。','Excluded by configuration.','已被配置排除。'],
 ['一覧にない選択です。番号またはIDを指定してください。','Choose a number or ID from the list.','请选择列表中的编号或ID。'],
 ['この項目は選択できません: {0}','This item cannot be selected: {0}','无法选择此项目：{0}'],
 ['↑↓で選択・Enterで確定。番号またはIDも入力できます。Ctrl+Cで取消。','Use ↑↓ then Enter, or enter a number or ID. Ctrl+C cancels.','按↑↓选择、Enter确认，也可输入编号或ID。Ctrl+C取消。'],
 ['モデル一覧の取得に失敗しました: HTTP {0}','Could not load models: HTTP {0}','获取模型列表失败：HTTP {0}'],
 ['モデル一覧の形式が不正です。','Invalid model list format.','模型列表格式不正确。'],
 ['登録済み','Registered','已注册'],['利用不可','Unavailable','不可用'],['接続確認済み','Connection verified','连接已确认'],
 ['外部Agentの優先指定を解除','Clear the preferred external agent','取消外部智能体优先指定'],
 ['選択を取り消しました。','Selection cancelled.','已取消选择。'],['優先Agent: {0}','Preferred agent: {0}','优先智能体：{0}'],
 ['外部Agentを一覧から選択、autoで優先指定を解除','Select an external agent; auto clears the preference','从列表选择外部智能体，auto取消优先指定'],
);
const catalog=new Map(entries.map(row=>[row[0],row]));
/** テンプレート引数を再解釈せず、元のUI文言にあるプレースホルダーだけを置換します。 */
export function cliText(key: string, ...params: unknown[]): string {
  const row=catalog.get(key),text=row?row[{ja:0,en:1,zh:2}[cliLanguage()]]:key;
  return text.replace(/\{(\d+)\}/g,(original,index)=>Number(index)<params.length?String(params[Number(index)]):original);
}
