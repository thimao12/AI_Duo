import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { findExecutable } from '../../../shared/exe.ts';

/**
 * Shell mode runner: runs one command the local user typed in the chat box, with the user's own shell.
 * Nothing but that typed text ever reaches the spawn call below; agent output and run data never come here.
 */

/* ---- Shell selection ---- */

export interface ShellSpec {
  name: 'pwsh' | 'powershell' | 'cmd' | 'posix';
  /** Absolute path of the shell executable. */
  file: string;
  /** Arguments that make the shell run `command` and exit. */
  args(command: string): string[];
  /** Windows: pass the arguments to CreateProcess untouched (cmd.exe parses its own command line). */
  verbatim: boolean;
}

export interface ShellDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Absolute path of `name` in the absolute PATH entries, if any. */
  find(name: string): string | undefined;
  /** True when `file` exists (Windows) or is executable (POSIX). */
  canRun(file: string): boolean;
}

function isRunnable(file: string): boolean {
  try {
    accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_DEPS: ShellDeps = { platform: process.platform, env: process.env, find: findExecutable, canRun: isRunnable };

/** PowerShell decodes native output with the console code page; make that UTF-8 so Vietnamese text survives. */
const UTF8_PREFIX = 'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }; ';

/** After the command: report the failing native program's own exit code (PowerShell would say 1). */
const EXIT_SUFFIX = '\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }';

const POWERSHELL_FLAGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'];

function powershellSpec(name: 'pwsh' | 'powershell', file: string): ShellSpec {
  return { name, file, verbatim: false, args: (command) => [...POWERSHELL_FLAGS, UTF8_PREFIX + command + EXIT_SUFFIX] };
}

function cmdSpec(file: string): ShellSpec {
  return { name: 'cmd', file, verbatim: true, args: (command) => ['/d', '/s', '/c', `"${command}"`] };
}

function windowsShell({ env, find, canRun }: ShellDeps): ShellSpec {
  const pwsh = find('pwsh');
  if (pwsh) return powershellSpec('pwsh', pwsh);
  const found = find('powershell');
  if (found) return powershellSpec('powershell', found);
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? String.raw`C:\Windows`;
  const builtin = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (canRun(builtin)) return powershellSpec('powershell', builtin);
  const comspec = env.ComSpec ?? env.COMSPEC;
  const cmd = comspec && path.win32.isAbsolute(comspec) ? comspec : path.win32.join(root, 'System32', 'cmd.exe');
  return cmdSpec(cmd);
}

/** The user's shell, by absolute path only: PowerShell (else cmd.exe) on Windows, $SHELL (else /bin/sh) elsewhere. */
export function selectShell(deps: Partial<ShellDeps> = {}): ShellSpec {
  const all = { ...DEFAULT_DEPS, ...deps };
  if (all.platform === 'win32') return windowsShell(all);
  const own = all.env.SHELL;
  const file = own && path.posix.isAbsolute(own) && all.canRun(own) ? own : '/bin/sh';
  return { name: 'posix', file, verbatim: false, args: (command) => ['-c', command] };
}

/* ---- Output sanitising ---- */

export type ShellStream = 'out' | 'err';

export interface ShellLine {
  text: string;
  stream: ShellStream | 'note';
}

const ESC = 0x1b;
const BEL = 0x07;

type ScrubState = 'text' | 'esc' | 'csi' | 'string' | 'stringEsc';

const isStringIntro = (ch: string) => ch === ']' || ch === 'P' || ch === '_' || ch === '^' || ch === 'X';

/**
 * Turns raw child output into text Ink can show: decodes UTF-8 (invalid bytes become U+FFFD), removes ANSI
 * escape sequences (also ones split across chunks), and drops control characters except \n, \r and \t.
 */
export class Scrubber {
  private readonly decoder = new StringDecoder('utf8');
  private state: ScrubState = 'text';

  feed(chunk: Buffer | string): string {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    return this.scrub(text);
  }

  flush(): string {
    return this.scrub(this.decoder.end());
  }

  private scrub(text: string): string {
    let out = '';
    for (const ch of text) out += this.step(ch);
    return out;
  }

  /** One character; returns what it contributes to the output. */
  private step(ch: string): string {
    const code = ch.codePointAt(0) ?? 0;
    switch (this.state) {
      case 'text':
        return this.text(ch, code);
      case 'esc':
        this.escape(ch, code);
        return '';
      case 'csi':
        // A final byte ends the sequence; a newline ends a malformed one.
        if ((code >= 0x40 && code <= 0x7e) || ch === '\n') this.state = 'text';
        return '';
      default:
        this.inString(code);
        return '';
    }
  }

  private text(ch: string, code: number): string {
    if (code === ESC) {
      this.state = 'esc';
      return '';
    }
    if (ch === '\n' || ch === '\r' || ch === '\t') return ch;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    return control ? '' : ch;
  }

  private escape(ch: string, code: number): void {
    if (ch === '[') this.state = 'csi';
    else if (isStringIntro(ch)) this.state = 'string';
    else if (code < 0x20 || code > 0x2f) this.state = 'text';
  }

  private inString(code: number): void {
    if (code === BEL) this.state = 'text';
    else if (this.state === 'stringEsc') this.state = code === 0x5c ? 'text' : 'string';
    else if (code === ESC) this.state = 'stringEsc';
  }
}

/* ---- Output buffer ---- */

const TAB_WIDTH = 8;
export const LINE_MAX = 2000;
export const HEAD_LINES = 100;
export const MAX_LINES = 2000;
export const MAX_BYTES = 200_000;

/**
 * Collects merged stdout/stderr as lines. A carriage return moves back to the start of the line so a
 * progress display overwrites itself; tabs become spaces. Keeps the first HEAD_LINES and the newest lines
 * within MAX_LINES / MAX_BYTES; the middle becomes an "… n lines omitted …" marker.
 */
export class ShellOutput {
  private readonly scrubbers: Record<ShellStream, Scrubber> = { out: new Scrubber(), err: new Scrubber() };
  private readonly head: ShellLine[] = [];
  private tail: ShellLine[] = [];
  private tailStart = 0;
  private omitted = 0;
  private bytes = 0;
  private current = '';
  private currentStream: ShellStream = 'out';
  private column = 0;
  private clipped = false;

  push(stream: ShellStream, chunk: Buffer | string): void {
    this.write(stream, this.scrubbers[stream].feed(chunk));
  }

  /** Flushes decoder remainders and the unfinished last line. */
  end(): void {
    for (const stream of ['out', 'err'] as const) this.write(stream, this.scrubbers[stream].flush());
    this.finishLine();
  }

  /** Everything kept so far, including the unfinished line (a prompt or a progress display). */
  lines(): ShellLine[] {
    const out = [...this.head];
    if (this.omitted > 0) out.push({ text: `… ${this.omitted} lines omitted …`, stream: 'note' });
    for (let i = this.tailStart; i < this.tail.length; i++) out.push(this.tail[i]);
    if (this.current !== '') out.push(this.currentLine());
    return out;
  }

  private write(stream: ShellStream, text: string): void {
    if (text === '') return;
    if (stream !== this.currentStream) {
      this.finishLine();
      this.currentStream = stream;
    }
    for (const ch of text) this.putChar(ch);
  }

  private putChar(ch: string): void {
    if (ch === '\n') this.finishLine(true);
    else if (ch === '\r') this.column = 0;
    else if (ch === '\t') this.putText(' '.repeat(TAB_WIDTH - (this.column % TAB_WIDTH)));
    else this.putText(ch);
  }

  private putText(text: string): void {
    for (const ch of text) {
      if (this.column >= LINE_MAX) {
        this.clipped = true;
        return;
      }
      this.current = this.column >= this.current.length ? this.current + ch : this.current.slice(0, this.column) + ch + this.current.slice(this.column + ch.length);
      this.column += ch.length;
    }
  }

  private currentLine(): ShellLine {
    return { text: this.clipped ? `${this.current}…` : this.current, stream: this.currentStream };
  }

  /** Stores the current line; an empty one only when a newline ended it (`force`). */
  private finishLine(force = false): void {
    const line = this.currentLine();
    const keep = force || this.current !== '';
    this.current = '';
    this.column = 0;
    this.clipped = false;
    if (keep) this.store(line);
  }

  private store(line: ShellLine): void {
    this.bytes += line.text.length + 1;
    if (this.omitted === 0 && this.tail.length === 0 && this.head.length < HEAD_LINES) {
      this.head.push(line);
      return;
    }
    this.tail.push(line);
    this.trim();
  }

  private trim(): void {
    const room = MAX_LINES - this.head.length;
    while (this.tail.length - this.tailStart > 1 && (this.tail.length - this.tailStart > room || this.bytes > MAX_BYTES)) {
      this.bytes -= this.tail[this.tailStart].text.length + 1;
      this.tailStart++;
      this.omitted++;
    }
    if (this.tailStart > 1000) {
      this.tail = this.tail.slice(this.tailStart);
      this.tailStart = 0;
    }
  }
}

/* ---- Runner ---- */

export type ShellState = 'exited' | 'interrupted' | 'timeout' | 'failed';

export interface ShellResult {
  state: ShellState;
  /** Exit code, or null when the process did not exit normally. */
  code: number | null;
  ms: number;
  lines: ShellLine[];
  /** Why the command could not start (state 'failed'). */
  error?: string;
}

export interface ShellOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell?: ShellSpec;
  /** Default 10 minutes. */
  timeoutMs?: number;
  /** Minimum time between onUpdate calls. Default 50 ms. */
  throttleMs?: number;
  onUpdate?(lines: ShellLine[]): void;
}

export interface ShellHandle {
  done: Promise<ShellResult>;
  /** Kills the command and everything it started; `done` then resolves with state 'interrupted'. */
  kill(): void;
}

export const SHELL_TIMEOUT_MS = 10 * 60_000;
const UPDATE_MS = 50;
/** After a kill, how long to wait for the pipes to close before giving up on them. */
const KILL_GRACE_MS = 1500;

/** Windows: taskkill /T /F (absolute path) ends the whole tree. POSIX: SIGKILL to the process group. */
function killTree(child: ChildProcess, posix: boolean): void {
  const { pid } = child;
  if (pid === undefined) return;
  if (posix) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    return;
  }
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? String.raw`C:\Windows`;
  const taskkill = path.win32.join(root, 'System32', 'taskkill.exe');
  const killer = spawn(taskkill, ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
  killer.on('error', () => child.kill());
}

class ShellJob {
  readonly done: Promise<ShellResult>;
  private resolve: (result: ShellResult) => void = () => {};
  private readonly output = new ShellOutput();
  private readonly started = Date.now();
  private readonly posix: boolean;
  private child: ChildProcess | undefined;
  private reason: 'none' | 'interrupted' | 'timeout' = 'none';
  private settled = false;
  private updateTimer: NodeJS.Timeout | undefined;
  private timeoutTimer: NodeJS.Timeout | undefined;
  private graceTimer: NodeJS.Timeout | undefined;

  constructor(
    command: string,
    private readonly options: ShellOptions,
  ) {
    this.done = new Promise((resolve) => {
      this.resolve = resolve;
    });
    const shell = options.shell ?? selectShell();
    this.posix = shell.name === 'posix';
    this.start(command, shell);
  }

  kill(): void {
    if (this.settled) return;
    if (this.reason === 'none') this.reason = 'interrupted';
    this.stop();
  }

  private start(command: string, shell: ShellSpec): void {
    try {
      const child = spawn(shell.file, shell.args(command), {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: shell.verbatim,
        detached: this.posix,
      });
      this.child = child;
      child.stdout.on('data', (chunk: Buffer) => this.data('out', chunk));
      child.stderr.on('data', (chunk: Buffer) => this.data('err', chunk));
      child.on('error', (err) => this.finish(null, err.message));
      child.on('close', (code) => this.finish(code));
      this.timeoutTimer = setTimeout(() => {
        this.reason = 'timeout';
        this.stop();
      }, this.options.timeoutMs ?? SHELL_TIMEOUT_MS);
    } catch (err) {
      this.finish(null, err instanceof Error ? err.message : String(err));
    }
  }

  private stop(): void {
    if (this.child) killTree(this.child, this.posix);
    this.graceTimer ??= setTimeout(() => {
      this.child?.stdout?.destroy();
      this.child?.stderr?.destroy();
      this.finish(null);
    }, KILL_GRACE_MS);
  }

  private data(stream: ShellStream, chunk: Buffer): void {
    this.output.push(stream, chunk);
    this.updateTimer ??= setTimeout(() => {
      this.updateTimer = undefined;
      if (!this.settled) this.options.onUpdate?.(this.output.lines());
    }, this.options.throttleMs ?? UPDATE_MS);
  }

  private finish(code: number | null, error?: string): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.updateTimer);
    clearTimeout(this.timeoutTimer);
    clearTimeout(this.graceTimer);
    this.output.end();
    const state: ShellState = error ? 'failed' : this.reasonState();
    this.resolve({ state, code, ms: Date.now() - this.started, lines: this.output.lines(), error });
  }

  private reasonState(): ShellState {
    return this.reason === 'none' ? 'exited' : this.reason;
  }
}

/** Runs `command` (the user's own text) in `options.cwd` with no stdin; output is merged in arrival order. */
export function runShell(command: string, options: ShellOptions): ShellHandle {
  const job = new ShellJob(command, options);
  return { done: job.done, kill: () => job.kill() };
}

const INPUT_PATTERN = /stdin|not a tty|not a terminal|inappropriate ioctl|input is redirected|cannot read keys|raw mode|EOF when reading|Read-Host|Unable to prompt|Non-interactive/i;

/** A hint when the output looks like a program that wanted keyboard input (none is attached). */
export function inputHint(lines: readonly ShellLine[]): string | undefined {
  const text = lines.map((l) => l.text).join('\n');
  return INPUT_PATTERN.test(text) ? 'no input is attached, so interactive programs cannot run here' : undefined;
}

/** `cd`-like commands do nothing between runs: every command starts in the session folder. */
export function isDirectoryChange(command: string): boolean {
  return /^\s*(?:cd|chdir|pushd|popd|set-location|sl)(?:\s|$)/i.test(command);
}
