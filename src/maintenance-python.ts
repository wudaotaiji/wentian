import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 導入と接続保守で同じPythonを選び、Windowsの実行エイリアスへの依存を避けます。 */
export function maintenancePythonCommand(platform: NodeJS.Platform = process.platform, override = process.env.WENTIAN_MAINTENANCE_PYTHON, installRoot = root): { executable: string; args: string[] } {
  const environment = ['.venv', '.wentian/planner-engine'].map(directory => path.join(installRoot, directory, platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')).find(candidate => existsSync(candidate));
  const executable = override?.trim() || environment || (platform === 'win32' ? 'py' : 'python3');
  return { executable, args: /^(?:.*[\\/])?py(?:\.exe)?$/i.test(executable) ? ['-3'] : [] };
}
