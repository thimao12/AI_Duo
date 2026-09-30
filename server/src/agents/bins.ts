import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { getCliSettingsSync } from '../settings.ts';
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

export interface ResolvedBin {
  /** Executable passed to spawn/execFile. */
  cmd: string;
  /** Arguments needed before the CLI's own arguments (the JS entry for npm shims). */
  prefixArgs: string[];
  /** The binary or shim selected from the override, PATH, or known locations. */
  resolvedFrom: string;
  /** Extra environment needed when Electron itself is used as the Node runtime. */
  env?: NodeJS.ProcessEnv;
  /** Where the executable came from: the CLAUDE_BIN/CODEX_BIN variable, the saved settings, PATH, a known install folder, or nowhere. */
  source: BinSource;
}

export type BinSource = 'env' | 'settings' | 'path' | 'known' | 'none';

function onPath(name: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd'] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (dir && existsSync(p)) return p;
    }
  }
}

function nodeOnPath(): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, `node${ext}`);
      if (dir && existsSync(p)) return p;
    }
  }
}

function launchFrom(name: AgentName, resolvedFrom: string, source: BinSource): ResolvedBin {
  if (process.platform !== 'win32' || !resolvedFrom.toLowerCase().endsWith('.cmd')) {
    return { cmd: resolvedFrom, prefixArgs: [], resolvedFrom, source };
  }

  const shimName = path.basename(resolvedFrom);
  let contents: string;
  try {
    contents = readFileSync(resolvedFrom, 'utf8');
  } catch {
    throw new Error(`Only found shim ${shimName}, set ${ENV[name]} to a supported executable path`);
  }

  const match = /"%(?:~)?dp0%?\\([^"\r\n]+\.js)"/i.exec(contents);
  if (!match) throw new Error(`Only found shim ${shimName}, set ${ENV[name]} to a supported executable path`);

  // npm shims quote a path relative to %dp0%; strip its leading slash before joining
  // so a Windows-rooted-looking entry stays inside the shim's directory.
  const entry = path.join(path.dirname(resolvedFrom), match[1].replace(/^[/\\]+/, ''));
  // Same order as the shim itself: a node.exe next to it wins over the one on PATH.
  const sibling = path.join(path.dirname(resolvedFrom), 'node.exe');
  const node = existsSync(sibling) ? sibling : nodeOnPath();
  if (node) return { cmd: node, prefixArgs: [entry], resolvedFrom, source };

  // Last resort: Electron as Node. The variable is inherited by everything the CLI runs,
  // so an Electron app started from the agent would also run in Node mode.
  return {
    cmd: process.execPath,
    prefixArgs: [entry],
    resolvedFrom,
    source,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/** The saved environment variables of a CLI merged under what the launch itself needs. */
function withUserEnv(bin: ResolvedBin, userEnv: Record<string, string> | undefined): ResolvedBin {
  if (!userEnv || !Object.keys(userEnv).length) return bin;
  return { ...bin, env: { ...userEnv, ...bin.env } };
}

function locate(name: AgentName): ResolvedBin {
  const override = process.env[ENV[name]];
  if (override) return launchFrom(name, override, 'env');

  const saved = getCliSettingsSync()[name].binPath;
  if (saved) return launchFrom(name, saved, 'settings');

  const onPathAt = onPath(name);
  if (onPathAt) return launchFrom(name, onPathAt, 'path');
  const known = KNOWN[name].find((p) => existsSync(p));
  if (known) return launchFrom(name, known, 'known');

  // Do not cache this fallback: PATH may change after the user installs a CLI.
  return { cmd: name, prefixArgs: [], resolvedFrom: name, source: 'none' };
}

/**
 * Resolve a CLI on demand so newly installed CLIs are visible without restarting the app.
 * Precedence: CLAUDE_BIN/CODEX_BIN, then the path saved in settings, then PATH, then known install folders.
 */
export function resolveBin(name: AgentName): ResolvedBin {
  return withUserEnv(locate(name), getCliSettingsSync()[name].env);
}
