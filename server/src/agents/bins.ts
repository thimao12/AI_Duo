import { existsSync, readFileSync } from 'node:fs';
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

export interface ResolvedBin {
  /** Executable passed to spawn/execFile. */
  cmd: string;
  /** Arguments needed before the CLI's own arguments (the JS entry for npm shims). */
  prefixArgs: string[];
  /** The binary or shim selected from the override, PATH, or known locations. */
  resolvedFrom: string;
  /** Extra environment needed when Electron itself is used as the Node runtime. */
  env?: NodeJS.ProcessEnv;
}

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

function launchFrom(name: AgentName, resolvedFrom: string): ResolvedBin {
  if (process.platform !== 'win32' || !resolvedFrom.toLowerCase().endsWith('.cmd')) {
    return { cmd: resolvedFrom, prefixArgs: [], resolvedFrom };
  }

  const shimName = path.basename(resolvedFrom);
  let contents: string;
  try {
    contents = readFileSync(resolvedFrom, 'utf8');
  } catch {
    throw new Error(`Only found shim ${shimName}, set ${ENV[name]} to a supported executable path`);
  }

  const match = contents.match(/"%(?:~)?dp0%?\\([^"\r\n]+\.js)"/i);
  if (!match) throw new Error(`Only found shim ${shimName}, set ${ENV[name]} to a supported executable path`);

  // npm shims quote a path relative to %dp0%; strip its leading slash before joining
  // so a Windows-rooted-looking entry stays inside the shim's directory.
  const entry = path.join(path.dirname(resolvedFrom), match[1].replace(/^[/\\]+/, ''));
  // Same order as the shim itself: a node.exe next to it wins over the one on PATH.
  const sibling = path.join(path.dirname(resolvedFrom), 'node.exe');
  const node = existsSync(sibling) ? sibling : nodeOnPath();
  if (node) return { cmd: node, prefixArgs: [entry], resolvedFrom };

  // Last resort: Electron as Node. The variable is inherited by everything the CLI runs,
  // so an Electron app started from the agent would also run in Node mode.
  return {
    cmd: process.execPath,
    prefixArgs: [entry],
    resolvedFrom,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/** Resolve a CLI on demand so newly installed CLIs are visible without restarting the app. */
export function resolveBin(name: AgentName): ResolvedBin {
  const override = process.env[ENV[name]];
  if (override) return launchFrom(name, override);

  const found = onPath(name) ?? KNOWN[name].find((p) => existsSync(p));
  if (found) return launchFrom(name, found);

  // Do not cache this fallback: PATH may change after the user installs a CLI.
  return { cmd: name, prefixArgs: [], resolvedFrom: name };
}
