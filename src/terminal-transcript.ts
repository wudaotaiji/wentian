import { Writable } from 'node:stream';
import type { WriteStream } from 'node:tty';
import type { TerminalInputLifecycle } from './terminal-appearance.js';

/** 会話本文は幅を確保したスナップショットへ渡し、入力欄と同じ描画器で出力します。 */
export function terminalTranscript(output: WriteStream, lifecycle: TerminalInputLifecycle): WriteStream {
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      try {
        if (lifecycle.controller) lifecycle.controller.write(chunk.toString('utf8'));
        else output.write(chunk);
        callback();
      } catch (error) { callback(error as Error); }
    },
  });
  Object.defineProperties(stream, {
    isTTY: { get: () => output.isTTY }, columns: { get: () => output.columns }, rows: { get: () => output.rows },
  });
  return stream as unknown as WriteStream;
}
