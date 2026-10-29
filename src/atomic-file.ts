import { rename } from 'node:fs/promises';

/** WindowsのAnti-virusやIndexerによる短時間のFile Lockを吸収してAtomic Renameを完了します。 */
export async function renameWithRetry(source: string, destination: string, attempts = 6): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { await rename(source, destination); return; }
    catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(String(code)) || attempt === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
  throw lastError;
}
