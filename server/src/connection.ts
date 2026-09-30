import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findExecutable } from '../../shared/exe.ts';
import { agentEnv } from './agents/billing.ts';
import { resolveBin, type ResolvedBin } from './agents/bins.ts';
import { binVersion } from './agents/check.ts';
import type { ConnectionStatus } from './types.ts';

export type ConnectionAgent = ConnectionStatus['agent'];

const STATUS_TIMEOUT_MS = 8_000;
const STATUS_ARGS: Record<ConnectionAgent, string[]> = { claude: ['auth', 'status', '--json'], codex: ['login', 'status'] };
const LOGIN_ARGS: Record<ConnectionAgent, string[]> = { claude: ['auth', 'login'], codex: ['login'] };

/** Runs a fixed CLI command and returns everything it printed; a non-zero exit still returns the output. */
export type StatusRunner = (bin: ResolvedBin, args: string[]) => Promise<string>;
/** Opens a terminal window running the command (absolute executable first). Resolves false when none could start. */
export type TerminalLauncher = (command: string[]) => Promise<boolean>;

export interface ConnectionDeps {
  resolveBin?: (name: ConnectionAgent) => ResolvedBin;
  version?: (bin: ResolvedBin) => Promise<{ version: string | null }>;
  run?: StatusRunner;
  launch?: TerminalLauncher;
}

const runStatus: StatusRunner = (bin, args) =>
  new Promise((resolve) => {
    try {
      execFile(bin.cmd, [...bin.prefixArgs, ...args], { timeout: STATUS_TIMEOUT_MS, windowsHide: true, shell: false, env: agentEnv(bin) }, (_err, out, errOut) => resolve(`${out}\n${errOut}`));
    } catch {
      resolve('');
    }
  });

/* ---- Status parsing ---- */

type Login = Pick<ConnectionStatus, 'loggedIn' | 'method' | 'account'>;
const UNKNOWN: Login = { loggedIn: null, method: null, account: null };
const NOT_LOGGED_IN = /not logged in|logged out|not signed in|please (log|sign) ?in|login required/i;
const short = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

export function parseClaudeStatus(output: string): Login {
  try {
    const parsed: unknown = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1));
    if (typeof parsed !== 'object' || parsed === null) return UNKNOWN;
    const status = parsed as Record<string, unknown>;
    if (typeof status.loggedIn !== 'boolean') return UNKNOWN;
    return status.loggedIn
      ? { loggedIn: true, method: short(status.authMethod, 60), account: short(status.email, 120) }
      : { loggedIn: false, method: null, account: null };
  } catch {
    return NOT_LOGGED_IN.test(output) ? { loggedIn: false, method: null, account: null } : UNKNOWN;
  }
}

export function parseCodexStatus(output: string): Login {
  if (NOT_LOGGED_IN.test(output)) return { loggedIn: false, method: null, account: null };
  const match = /logged in(?: using)?\s+([^\r\n]*)/i.exec(output);
  if (!match) return UNKNOWN;
  return { loggedIn: true, method: short(match[1], 60), account: null };
}

const PARSERS: Record<ConnectionAgent, (output: string) => Login> = { claude: parseClaudeStatus, codex: parseCodexStatus };

function locate(agent: ConnectionAgent, deps: ConnectionDeps): ResolvedBin | undefined {
  try {
    const bin = (deps.resolveBin ?? resolveBin)(agent);
    return bin.source === 'none' ? undefined : bin;
  } catch {
    return undefined;
  }
}

export async function getConnection(agent: ConnectionAgent, deps: ConnectionDeps = {}): Promise<ConnectionStatus> {
  const base: ConnectionStatus = { agent, installed: false, version: null, path: null, loggedIn: null, method: null, account: null, error: null };
  const bin = locate(agent, deps);
  if (!bin) return { ...base, error: 'CLI not found' };
  const { version } = await (deps.version ?? binVersion)(bin);
  if (!version) return { ...base, path: bin.resolvedFrom, error: 'CLI could not be run' };
  const output = await (deps.run ?? runStatus)(bin, STATUS_ARGS[agent]);
  const login = PARSERS[agent](output);
  return { ...base, installed: true, version: short(version, 80), path: bin.resolvedFrom, ...login, error: login.loggedIn === null ? 'Login status unknown' : null };
}

/* ---- Login terminal ---- */

const spawnDetached = (command: string, args: string[], verbatim = false): Promise<boolean> =>
  new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false, windowsVerbatimArguments: verbatim });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });

// Characters that would change meaning inside a cmd.exe command line.
const UNSAFE_CMD = /["%^&|<>!\r\n]/;

async function launchWindows(command: string[]): Promise<boolean> {
  if (command.some((part) => UNSAFE_CMD.test(part))) return false;
  const cmdExe = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'cmd.exe');
  const inner = command.map((part) => `"${part}"`).join(' ');
  // /s strips one outer quote pair at each level, so both cmd.exe instances see the quoted paths intact.
  return spawnDetached(cmdExe, ['/d', '/s', '/c', `"start "" "${cmdExe}" /d /s /k "${inner}""`], true);
}

function shellQuote(part: string): string {
  const escaped = part.replaceAll("'", String.raw`'\''`);
  return `'${escaped}'`;
}

async function launchMac(command: string[]): Promise<boolean> {
  const script = path.join(await mkdtemp(path.join(tmpdir(), 'ai-duo-login-')), 'login.command');
  await writeFile(script, `#!/bin/sh\n${command.map(shellQuote).join(' ')}\n`, { mode: 0o700 });
  await chmod(script, 0o700);
  return spawnDetached('/usr/bin/open', ['-a', 'Terminal', script]);
}

// Terminal emulators and how each takes the command to run.
const TERMINALS: { name: string; flag: string[] }[] = [
  { name: 'x-terminal-emulator', flag: ['-e'] },
  { name: 'gnome-terminal', flag: ['--'] },
  { name: 'konsole', flag: ['-e'] },
  { name: 'xfce4-terminal', flag: ['-x'] },
  { name: 'xterm', flag: ['-e'] },
];

async function launchLinux(command: string[]): Promise<boolean> {
  for (const terminal of TERMINALS) {
    const exe = findExecutable(terminal.name);
    if (exe && (await spawnDetached(exe, [...terminal.flag, ...command]))) return true;
  }
  return false;
}

export const launchInTerminal: TerminalLauncher = async (command) => {
  try {
    if (process.platform === 'win32') return await launchWindows(command);
    if (process.platform === 'darwin') return await launchMac(command);
    return await launchLinux(command);
  } catch {
    return false;
  }
};

export type LoginOutcome = 'opened' | 'notInstalled' | 'failed';

/** Open a terminal running `<cli> auth login` / `<cli> login`; the command comes only from the resolved CLI and a fixed argument list. */
export async function openLogin(agent: ConnectionAgent, deps: ConnectionDeps = {}): Promise<LoginOutcome> {
  const bin = locate(agent, deps);
  if (!bin || !path.isAbsolute(bin.cmd)) return 'notInstalled';
  const opened = await (deps.launch ?? launchInTerminal)([bin.cmd, ...bin.prefixArgs, ...LOGIN_ARGS[agent]]);
  return opened ? 'opened' : 'failed';
}
