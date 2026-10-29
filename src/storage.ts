/**
 * 秘密情報やプロンプト本文を保存しない、上限付き JSONL 永続化ストア。
 * 追記後に件数・ファイルサイズ・保存期間を適用し、ディスク肥大化を防ぐ。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { renameWithRetry } from './atomic-file.js';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type PersistentEventKind = 'routing' | 'metric' | 'audit' | 'circuit';

export interface PersistentEvent {
  id: string;
  kind: PersistentEventKind;
  occurredAt: string;
  provider?: string;
  model?: string;
  success?: boolean;
  latencyMs?: number;
  action?: string;
  state?: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface StorageOptions {
  path: string;
  maxRecords?: number;
  maxBytes?: number;
  maxAgeMs?: number;
}

const FORBIDDEN_KEYS = /(?:prompt|messages?|content|api.?key|authorization|token|secret|password)/i;

function sanitize(event: Omit<PersistentEvent, 'id' | 'occurredAt'> & Partial<Pick<PersistentEvent, 'id' | 'occurredAt'>>): PersistentEvent {
  const detail = event.detail
    ? Object.fromEntries(Object.entries(event.detail).filter(([key, value]) => !FORBIDDEN_KEYS.test(key) ||
        // 数値の使用量は秘密トークン（Secret Token）と区別し、本文や認証値は許可しません。
        (['promptTokens', 'outputTokens'].includes(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0)))
    : undefined;
  return { ...event, id: event.id ?? randomUUID(), occurredAt: event.occurredAt ?? new Date().toISOString(), detail };
}

/** 同一プロセス内の書き込みを直列化し、途中状態の JSONL を作らない。 */
export class JsonlEventStore {
  private queue: Promise<void> = Promise.resolve();
  readonly options: Required<StorageOptions>;

  constructor(options: StorageOptions) {
    this.options = {
      path: options.path,
      maxRecords: options.maxRecords ?? 10_000,
      maxBytes: options.maxBytes ?? 16 * 1024 * 1024,
      maxAgeMs: options.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000,
    };
    if (this.options.maxRecords < 1 || this.options.maxBytes < 1024 || this.options.maxAgeMs < 1) {
      throw new Error('永続化の保持上限は正の値で指定してください。');
    }
  }

  async append(event: Parameters<typeof sanitize>[0]): Promise<PersistentEvent> {
    const clean = sanitize(event);
    this.queue = this.queue.catch(() => undefined).then(() => this.writeAndCompact(clean));
    await this.queue;
    return clean;
  }

  async list(options: { kind?: PersistentEventKind; limit?: number } = {}): Promise<PersistentEvent[]> {
    await this.queue;
    const all = await this.readAll();
    return all.filter((item) => Date.parse(item.occurredAt) >= Date.now() - this.options.maxAgeMs && (!options.kind || item.kind === options.kind)).slice(-(options.limit ?? 100));
  }

  private async readAll(): Promise<PersistentEvent[]> {
    try {
      const text = await readFile(this.options.path, 'utf8');
      return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as PersistentEvent]; } catch { return []; }
      });
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  private async writeAndCompact(event: PersistentEvent): Promise<void> {
    await mkdir(dirname(this.options.path), { recursive: true });
    const cutoff = Date.now() - this.options.maxAgeMs;
    let records = [...await this.readAll(), event]
      .filter((item) => Date.parse(item.occurredAt) >= cutoff)
      .slice(-this.options.maxRecords);
    while (Buffer.byteLength(records.map((item) => JSON.stringify(item)).join('\n') + '\n') > this.options.maxBytes && records.length > 1) {
      records = records.slice(1);
    }
    const temporary = `${this.options.path}.${process.pid}.tmp`;
    await writeFile(temporary, records.map((item) => JSON.stringify(item)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    await renameWithRetry(temporary, this.options.path);
    // stat は書き込み完了確認を兼ねる。異常時は呼び出し側へ例外を返す。
    await stat(this.options.path);
  }
}
