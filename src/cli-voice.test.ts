import test from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CliVoiceInput, voiceText, localVoiceDependencies, type VoiceDependencies } from './cli-voice.js';
import { selectCliLanguage } from './cli-language.js';
import { parseSlashCommand } from './slash-command.js';

function fixture(transcribe?: VoiceDependencies['transcribe']) {
  let end!: () => void, fail!: (error: Error) => void, directory = '', cancelled = 0;
  const done = new Promise<void>((resolve, reject) => { end = resolve; fail = reject; });
  const inserted: string[] = [], notices: string[] = [];
  const voice = new CliVoiceInput(text => inserted.push(text), text => notices.push(text), {
    async record(dir) { directory = dir; await writeFile(path.join(dir, 'capture.bin'), 'isolated fixture'); return { done, stop: () => end(), cancel: () => { cancelled++; fail(new Error('cancel')); } }; },
    transcribe: transcribe || (async () => '認識した草稿'),
  });
  return { voice, inserted, notices, directory: () => directory, cancelled: () => cancelled, end, fail };
}
async function idle(voice: CliVoiceInput) {
  for (let i = 0; i < 100 && voice.state !== 'idle'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(voice.state, 'idle');
}

test('音声入力: 三言語で開始・停止・下書き追加・一時音声削除', async () => {
  for (const language of ['ja', 'en', 'zh'] as const) {
    selectCliLanguage(language);
    let received = '';
    const f = fixture(async (_directory, value) => { received = value; return 'Tokyo 東京 东京'; });
    await f.voice.command('start'); assert.equal(f.voice.state, 'recording'); assert.deepEqual(f.inserted, []);
    await f.voice.command('start'); assert.equal(f.voice.state, 'recording');
    await f.voice.command('stop'); await idle(f.voice);
    assert.equal(received, language); assert.deepEqual(f.inserted, ['Tokyo 東京 东京']);
    assert.ok(f.notices.includes(voiceText('inserted')));
    await assert.rejects(access(f.directory()));
  }
  selectCliLanguage('ja');
});
test('録音取消は子処理を終了し、音声を削除する', async () => {
  const f = fixture(); await f.voice.command('start'); await f.voice.command('cancel');
  assert.equal(f.cancelled(), 1); assert.equal(f.voice.state, 'idle'); assert.deepEqual(f.inserted, []);
  await assert.rejects(access(f.directory()));
});
test('文字起こし取消後の遅着結果は新会話へ挿入しない', async () => {
  let resolve!: (text: string) => void;
  const f = fixture(async () => new Promise<string>(r => { resolve = r; }));
  await f.voice.command('start'); f.voice.stop();
  while (f.voice.state === 'recording') await new Promise(r => setTimeout(r, 1));
  const cancelled = f.voice.cancel(); resolve('遅着結果'); await cancelled;
  assert.deepEqual(f.inserted, []); assert.equal(f.voice.state, 'idle'); await assert.rejects(access(f.directory()));
});
test('録音失敗・認識失敗・無音で自動送信も下書き破壊もしない', async () => {
  for (const run of [async () => '', async () => { throw new Error('秘密の機器名'); }]) {
    const f = fixture(run); await f.voice.command('start'); f.voice.stop(); await idle(f.voice);
    assert.deepEqual(f.inserted, []); assert.ok(!f.notices.join('').includes('秘密'));
    await assert.rejects(access(f.directory()));
  }
  const f = fixture(); await f.voice.command('start'); f.fail(new Error('device')); await idle(f.voice);
  assert.ok(f.notices.includes(voiceText('error'))); await assert.rejects(access(f.directory()));
});
test('機器未設定はマイクを開かず失敗し、コマンドは明示的に解析する', async () => {
  const previous = process.env.WENTIAN_VOICE_DEVICE; delete process.env.WENTIAN_VOICE_DEVICE;
  try { await assert.rejects(localVoiceDependencies.record('unused'), /device/); }
  finally { if (previous !== undefined) process.env.WENTIAN_VOICE_DEVICE = previous; }
  assert.deepEqual(parseSlashCommand('/voice start'), { name: 'voice', argument: 'start' });
  assert.equal(parseSlashCommand('音声入力を開始してください'), undefined);
});
