import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Same folder Electron uses as the desktop app's userData, so the dev server, desktop app and
 * CLI all share one run history: %APPDATA%\AI Duo on Windows.
 *
 * Kept free of side effects: the CLI imports it to set env vars before paths.ts is evaluated.
 */
export function appDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') return path.join(env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'AI Duo');
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'AI Duo');
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'AI Duo');
}
