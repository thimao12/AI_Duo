import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentName } from './types.ts';

const ENV: Record<AgentName, string> = { claude: 'CLAUDE_BIN', codex: 'CODEX_BIN' };

// Default install locations, for when the app is launched with a stale or minimal PATH
// (e.g. double-clicked from Explorer right after installing a CLI).
const KNOWN: Record<AgentName, string[]> = {
  claude: [path.join(homedir(), '.local', 'bin', 'claude.exe'), path.join(homedir(), '.local', 'bin', 'claude')],
  codex: [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    path.join(homedir(), '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ],
};

const cache = new Map<AgentName, string>();

function onPath(name: string): string | undefined {
  // Only real executables: spawn() without a shell can't run .cmd/.bat shims.
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (dir && existsSync(p)) return p;
    }
  }
}

/** Absolute path to the agent CLI, or its bare name if nothing is found (spawn then reports ENOENT). */
export function resolveBin(name: AgentName): string {
  const override = process.env[ENV[name]];
  if (override) return override;
  let bin = cache.get(name);
  if (!bin) {
    bin = onPath(name) ?? KNOWN[name].find((p) => existsSync(p)) ?? name;
    cache.set(name, bin);
  }
  return bin;
}
