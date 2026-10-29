import { TaskScheduler, type Timing } from './task-scheduler.js';

/** CLIと対話コマンドで同一の予約操作を利用します。依頼文は --prompt の値として受け取ります。 */
export async function scheduleCommand(args: string[], scheduler = new TaskScheduler()): Promise<string> {
  const [action = 'list', id] = args;
  const value = (name: string) => { const index = args.indexOf(name); if (index < 0) return undefined; if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} の値が必要です。`); return args[index + 1]; };
  if (action === 'list') return JSON.stringify(await scheduler.list(), null, 2);
  if (['pause', 'resume', 'remove'].includes(action)) {
    if (!id) throw new Error('予約IDを指定してください。');
    await scheduler.manage(id, action as 'pause' | 'resume' | 'remove'); return `予約を更新しました: ${action} ${id}`;
  }
  if (action !== 'add') throw new Error('予約操作: add | list | pause ID | resume ID | remove ID');
  const at = value('--at'), every = value('--every'), daily = value('--daily');
  if ([at, every, daily].filter(item => item !== undefined).length !== 1) throw new Error('--at、--every、--daily のいずれか1つを指定してください。');
  let timing: Timing;
  if (at) timing = { at };
  else if (daily) timing = { daily, timezone: value('--timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone };
  else {
    const match = every?.match(/^(\d+)(s|m|h|d)$/);
    if (!match) throw new Error('間隔は 30s、10m、2h、1d の形式で指定してください。');
    timing = { everyMs: Number(match[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]]!) };
  }
  const task = await scheduler.add({ prompt: value('--prompt') || '', timing, workspace: value('--workspace'), server: value('--server'), model: value('--model') });
  return `予約を作成しました: ${task.id}\n次回: ${task.nextRunAt}\n実行には wentian daemon start または wentian server が必要です。`;
}
