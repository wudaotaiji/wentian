import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renameWithRetry } from './atomic-file.js';

export interface TrainingExample {
  id: string; createdAt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  metadata: { model: string; language: string; imageCount: number; source: 'wentian-agent'; schemaVersion: '1.0' };
}

interface TrainingSettings { enabled: boolean; updatedAt: string; }

function root(): string { return path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), '.wentian', 'training'); }
export function trainingDataPath(): string { return process.env.WENTIAN_TRAINING_DATA_PATH || path.join(root(), 'examples.jsonl'); }
function settingsPath(): string { return path.join(root(), 'settings.json'); }

/** 学習例へ保存する前に秘密値、メールアドレス、個人Home Pathを伏字化します。 */
export function redactTrainingText(value: string): string {
  return value
    .replace(/\b(?:authorization\s*:\s*bearer|bearer)\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:api[_-]?key|token|secret|password|passwd|preshared[_ -]?key)\s*[:=]\s*["']?[^\s,"']+/gi, match => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/[A-Z]:\\Users\\[^\\\s"']+/gi, '<USER_HOME>')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]')
    .slice(0, 32_000);
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await renameWithRetry(temporary, target);
}

export class TrainingDataStore {
  private queue: Promise<void> = Promise.resolve();

  async enabled(): Promise<boolean> {
    try { return (JSON.parse(await readFile(settingsPath(), 'utf8')) as TrainingSettings).enabled === true; } catch { return false; }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await atomicWrite(settingsPath(), `${JSON.stringify({ enabled, updatedAt: new Date().toISOString() } satisfies TrainingSettings, null, 2)}\n`);
  }

  async status(): Promise<{ enabled: boolean; path: string; examples: number; bytes: number }> {
    let text = ''; try { text = await readFile(trainingDataPath(), 'utf8'); } catch { /* 未作成時は0件です。 */ }
    let bytes = 0; try { bytes = (await stat(trainingDataPath())).size; } catch { /* 未作成時は0 Bytesです。 */ }
    return { enabled: await this.enabled(), path: trainingDataPath(), examples: text.split(/\r?\n/).filter(Boolean).length, bytes };
  }

  async append(input: { user: string; assistant: string; model: string; language: string; imageCount: number }): Promise<boolean> {
    if (!(await this.enabled()) || !input.user.trim() || !input.assistant.trim()) return false;
    const example: TrainingExample = { id: randomUUID(), createdAt: new Date().toISOString(), messages: [{ role: 'user', content: redactTrainingText(input.user) }, { role: 'assistant', content: redactTrainingText(input.assistant) }], metadata: { model: input.model, language: input.language, imageCount: input.imageCount, source: 'wentian-agent', schemaVersion: '1.0' } };
    this.queue = this.queue.then(async () => {
      let existing = ''; try { existing = await readFile(trainingDataPath(), 'utf8'); } catch { /* 初回は空です。 */ }
      const maxRecords = Math.max(1, Number(process.env.WENTIAN_TRAINING_MAX_RECORDS) || 10_000);
      const maxBytes = Math.max(1024, Number(process.env.WENTIAN_TRAINING_MAX_BYTES) || 64 * 1024 * 1024);
      let lines = [...existing.split(/\r?\n/).filter(Boolean), JSON.stringify(example)].slice(-maxRecords);
      while (Buffer.byteLength(`${lines.join('\n')}\n`) > maxBytes && lines.length > 1) lines = lines.slice(1);
      await atomicWrite(trainingDataPath(), `${lines.join('\n')}\n`);
    });
    await this.queue; return true;
  }
}
