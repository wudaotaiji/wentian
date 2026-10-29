import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliLanguage, type CliLanguage } from './cli-language.js';

const root = fileURLToPath(new URL('../', import.meta.url));
/** Windowsでは変換用FFmpegを含め、対象ワーカーの子プロセスだけを終了します。 */
function terminate(child: ChildProcess) {
  if (process.platform === 'win32' && child.pid && child.exitCode === null) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { if (child.exitCode === null) child.kill(); });
  } else if (child.exitCode === null) child.kill();
}
export type VoiceState = 'idle' | 'recording' | 'transcribing';
export interface VoiceRecorder { done: Promise<void>; stop(): void; cancel(): void; }
export interface VoiceDependencies {
  record(directory: string): Promise<VoiceRecorder>;
  transcribe(directory: string, language: CliLanguage, signal: AbortSignal): Promise<string>;
}

/** 子プロセスの終了まで待ち、一時ファイルの削除と競合させません。生ログは公開しません。 */
function completion(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('worker')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('worker')));
  });
}

export const localVoiceDependencies: VoiceDependencies = {
  async record(directory) {
    const device = process.env.WENTIAN_VOICE_DEVICE;
    const format = process.env.WENTIAN_VOICE_FORMAT || (process.platform === 'win32' ? 'dshow' : process.platform === 'darwin' ? 'avfoundation' : 'pulse');
    if (!device || !['dshow', 'avfoundation', 'pulse', 'alsa'].includes(format)) throw new Error('device');
    const executable = process.env.WENTIAN_FFMPEG || path.join(root, '.wentian/video-engine/ffmpeg/ffmpeg.exe');
    // 明示された機器だけを開き、5分・16kHzモノラルPCMに制限します。シェルは使用しません。
    const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-y', '-f', format, '-i', format === 'dshow' ? `audio=${device}` : device,
      '-t', '300', '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', path.join(directory, 'capture.bin')],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const done = completion(child); void done.catch(() => {});
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.stdin!.on('error', () => {});
    let stopping = false;
    return { done, stop() { if (!stopping) { stopping = true; child.stdin?.write('q\n'); } }, cancel() { terminate(child); } };
  },
  async transcribe(directory, language, signal) {
    signal.throwIfAborted();
    const python = process.env.WENTIAN_VIDEO_PYTHON || path.join(root, '.wentian/video-engine', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const child = spawn(python, [path.join(root, 'scripts/meeting-transcribe.py'), '--directory', directory, '--language', language], {
      windowsHide: true, stdio: 'ignore', env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
    });
    const abort = () => { terminate(child); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(abort, 300_000);
    try {
      await completion(child); signal.throwIfAborted();
      const raw = await readFile(path.join(directory, 'transcript.json'), 'utf8');
      if (raw.length > 200_000) throw new Error('transcript');
      const rows: unknown = JSON.parse(raw).segments;
      if (!Array.isArray(rows) || rows.length > 1000 || rows.some(row => !row || typeof row.text !== 'string')) throw new Error('transcript');
      // 制御文字・端末のエスケープシーケンスは下書きへ持ち込みません。
      const text = rows.map(row => row.text).join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
      if (text.length > 30_000) throw new Error('transcript');
      return text;
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
  },
};

const messages = {
  usage: ['/voice start | stop | cancel | status（停止はCtrl+Rでも可能）', '/voice start | stop | cancel | status (Ctrl+R also stops)', '/voice start | stop | cancel | status（也可按 Ctrl+R 停止）'],
  recording: ['録音中（最大5分）。/voice stop またはCtrl+Rで文字起こし。', 'Recording (up to 5 minutes). /voice stop or Ctrl+R to transcribe.', '正在录音（最长5分钟）。/voice stop 或 Ctrl+R 开始转写。'],
  transcribing: ['ローカルで文字起こし中… /voice cancelで取消', 'Transcribing locally… /voice cancel to cancel', '正在本地转写… /voice cancel 取消'],
  idle: ['音声入力: 待機', 'Voice input: idle', '语音输入：待机'],
  inserted: ['認識結果を下書きへ追加しました。確認してEnterで送信してください。', 'Transcript added to the draft. Review it and press Enter to send.', '转写结果已加入草稿。请确认后按 Enter 发送。'],
  empty: ['音声を認識できませんでした。', 'No speech was recognized.', '未识别到语音。'],
  cancelled: ['音声入力を取り消しました。', 'Voice input cancelled.', '已取消语音输入。'],
  error: ['音声入力に失敗しました。WENTIAN_VOICE_DEVICE、FFmpeg、Python、ローカルWhisperモデルを確認してください。', 'Voice input failed. Check WENTIAN_VOICE_DEVICE, FFmpeg, Python and the local Whisper model.', '语音输入失败。请检查 WENTIAN_VOICE_DEVICE、FFmpeg、Python 和本地 Whisper 模型。'],
  unavailable: ['音声入力には常駐入力欄が必要です。WindowsではWentian付属のBunで起動してください。', 'Voice input requires the persistent editor. On Windows, start with the bundled Bun runtime.', '语音输入需要常驻输入框。在 Windows 上请使用 Wentian 附带的 Bun 启动。'],
} as const;
export function voiceText(key: keyof typeof messages) { return messages[key][{ ja: 0, en: 1, zh: 2 }[cliLanguage()]]; }

/** 一度に一録音だけ保持し、取消後に遅着した認識結果を入力欄へ反映しません。 */
export class CliVoiceInput {
  state: VoiceState = 'idle';
  private active?: { directory: string; abort: AbortController; recorder?: VoiceRecorder; language: CliLanguage; finished?: Promise<void>; timer?: ReturnType<typeof setTimeout> };
  constructor(private readonly insert: (text: string) => void, private readonly notify: (text: string) => void, private readonly deps = localVoiceDependencies) {}
  async command(action: string): Promise<void> {
    if (action === 'status') { this.notify(voiceText(this.state)); return; }
    if (action === 'cancel') { await this.cancel(); this.notify(voiceText('cancelled')); return; }
    if (action === 'stop') { this.stop(); return; }
    if (action !== 'start') { this.notify(voiceText('usage')); return; }
    if (this.active) { this.notify(voiceText(this.state)); return; }
    const entry = { directory: await mkdtemp(path.join(tmpdir(), 'wentian-voice-')), abort: new AbortController(), language: cliLanguage() } as NonNullable<CliVoiceInput['active']>;
    this.active = entry; this.state = 'recording';
    try {
      entry.recorder = await this.deps.record(entry.directory);
      if (entry.abort.signal.aborted) entry.recorder.cancel();
      else { this.notify(voiceText('recording')); entry.timer = setTimeout(() => this.stop(), 300_000); }
      entry.finished = (async () => {
        try {
          await entry.recorder!.done;
          clearTimeout(entry.timer);
          if (entry.abort.signal.aborted) return;
          this.state = 'transcribing'; this.notify(voiceText('transcribing'));
          const text = await this.deps.transcribe(entry.directory, entry.language, entry.abort.signal);
          if (!entry.abort.signal.aborted) { if (text) this.insert(text); this.notify(voiceText(text ? 'inserted' : 'empty')); }
        } catch { if (!entry.abort.signal.aborted) this.notify(voiceText('error')); }
        finally { clearTimeout(entry.timer); await rm(entry.directory, { recursive: true, force: true }); if (this.active === entry) { this.active = undefined; this.state = 'idle'; } }
      })();
    } catch {
      await rm(entry.directory, { recursive: true, force: true });
      if (this.active === entry) { this.active = undefined; this.state = 'idle'; }
      this.notify(voiceText('error'));
    }
  }
  stop() {
    const entry = this.active;
    if (entry?.recorder && this.state === 'recording') {
      entry.recorder.stop();
      // 録音停止に応答しない機器は終了させ、未完了音声を認識しません。
      clearTimeout(entry.timer); entry.timer = setTimeout(() => entry.recorder?.cancel(), 5000);
    } else this.notify(voiceText(this.state));
  }
  async cancel() {
    const entry = this.active;
    if (!entry) return;
    entry.abort.abort(); entry.recorder?.cancel();
    await entry.finished;
  }
}
