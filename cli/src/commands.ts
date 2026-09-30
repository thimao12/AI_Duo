import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { AgentCheck, AgentName } from '../../server/src/agents/types.ts';
import { gitExecutable, gitRequiredMessage, gitToplevel, isGitRepo } from '../../server/src/git.ts';
import { describeOwner, listLocks, lockTarget, ownerState, readLockOwner, unlockRepo } from '../../server/src/lock.ts';
import { paths } from '../../server/src/paths.ts';
import { authorizeDirectory, DirectoryAccessError } from '../../server/src/project-directories.ts';
import { RunService, ServiceError, type RunHandle, type RunRequest, type ServiceErrorCode, type StartOptions } from '../../server/src/service.ts';
import type { Mode, Run } from '../../server/src/types.ts';
import { DecisionController } from './decisions.ts';
import { invocationCwd, seedPrompts } from './env.ts';
import { formatUsage, makeStyle, ProgressRenderer, transcript, type Style } from './render.ts';

export const VERSION = '0.1.0';

/** 0 done · 1 run failed · 2 usage or invalid request · 3 preflight failed · 4 repository locked · 130 cancelled. */
export const EXIT = { ok: 0, failed: 1, usage: 2, preflight: 3, locked: 4, cancelled: 130 } as const;
const EXIT_FOR: Record<ServiceErrorCode, number> = { invalid: EXIT.usage, not_found: EXIT.usage, conflict: EXIT.locked, preflight: EXIT.preflight, internal: EXIT.failed };

export const HELP = `ai-duo ${VERSION} – Claude × Codex pair programming in the terminal

Usage:
  ai-duo run "<request>" [options]        start a Code or Plan run in --cwd (default: current folder)
  ai-duo continue <run-id> "<request>"    follow up on a finished run, in the same thread
  ai-duo runs [--all] [--limit N]         recent runs (default: runs in this repository)
  ai-duo show <run-id> [--diff]           print a saved run
  ai-duo doctor                           check Node, Git, both agent CLIs and their logins
  ai-duo unlock [folder] [--force]        remove a repository lock left by a process that died

Run options:
  -m, --mode code|plan          code edits files (needs Git); plan is read-only first (default: code;
                                continue defaults to the run's current mode)
  -C, --cwd <folder>            working folder (run only)
      --test "<command>"        test command the reviewer runs
      --claude-model <name>     --codex-model <name>      override the routed model
      --claude-effort <level>   --codex-effort <level>    override the reasoning effort
      --timeout <minutes>       limit per agent turn (1-180, default 30)
      --skip-auth-check         run although a CLI cannot report its login status
                                (a confirmed missing or metered login still stops)

Decisions (asked on the terminal; without a TTY every decision stops unless a flag decides):
      --plan-decision approve|stop   answer Plan approval; approve starts Code, which edits files
      --pair-extra-rounds <N>        extra Code review rounds allowed after the limit (default 0;
                                     granted in blocks of 2, never beyond N)

Output:
      --json        machine-readable result on stdout
  -q, --quiet       no progress on stderr
  -v, --verbose     include tool output and raw CLI lines
      --no-color    plain text (also when NO_COLOR is set or stderr is not a terminal)

Exit codes: 0 done · 1 run failed · 2 invalid request · 3 agent check failed · 4 repository locked · 130 cancelled

Data (shared with the desktop app; override with AI_DUO_DATA_DIR / AI_DUO_PROMPTS_DIR):
  runs     ${paths.dataDir}
  prompts  ${paths.promptsDir}

Projects: AI_DUO_ALLOWED_ROOTS is a JSON array of absolute folders. By default only the
startup working folder and its descendants are allowed. Restart after changing the roots.
`;

const OPTIONS = {
  mode: { type: 'string', short: 'm' },
  cwd: { type: 'string', short: 'C' },
  test: { type: 'string' },
  'claude-model': { type: 'string' },
  'codex-model': { type: 'string' },
  'claude-effort': { type: 'string' },
  'codex-effort': { type: 'string' },
  timeout: { type: 'string' },
  'skip-auth-check': { type: 'boolean' },
  'plan-decision': { type: 'string' },
  'pair-extra-rounds': { type: 'string' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  verbose: { type: 'boolean', short: 'v' },
  'no-color': { type: 'boolean' },
  all: { type: 'boolean' },
  limit: { type: 'string' },
  diff: { type: 'boolean' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} satisfies ParseArgsConfig['options'];

type Flags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>['values'];

function readGitVersion(): string | null {
  try {
    return execFileSync(gitExecutable(), ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return null;
  }
}

function doctorJson(d: {
  cwd: string;
  git: string | null;
  gitVersion: string | null;
  promptsReady: string | null;
  owner: Awaited<ReturnType<typeof readLockOwner>> | undefined;
  report: Awaited<ReturnType<RunService['preflight']>>;
  locks: Awaited<ReturnType<typeof listLocks>>;
}) {
  const { cwd, git, gitVersion, promptsReady, owner, report, locks } = d;
  return {
    ok: report.ok && !!gitVersion && !promptsReady,
    node: process.version,
    git: gitVersion,
    dataDir: paths.dataDir,
    promptsDir: paths.promptsDir,
    cwd,
    repository: git,
    lock: owner === undefined ? null : { owner, state: ownerState(owner) },
    agents: report.checks,
    problems: [...(gitVersion ? [] : ['git not found on PATH']), ...(promptsReady ? [promptsReady] : []), ...report.problems],
    locks,
  };
}

class UsageError extends Error {}

export interface Io {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Registers the Ctrl+C handler; returns a function that removes it. */
  onInterrupt(fn: () => void): () => void;
}

export function defaultIo(): Io {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: invocationCwd(),
    onInterrupt: (fn) => {
      process.on('SIGINT', fn);
      return () => process.off('SIGINT', fn);
    },
  };
}

const service = new RunService({ app: 'cli' });

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`--${name} must be ${allowed.join(' or ')}`);
  return value as T;
}

function count(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new UsageError(`--${name} must be a whole number ≥ 0`);
  return n;
}

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += chunk.toString();
  return text;
}

/** Request fields shared by run and continue. */
function requestFrom(flags: Flags): Omit<RunRequest, 'prompt' | 'mode' | 'cwd'> {
  const timeout = flags.timeout === undefined ? undefined : Number(flags.timeout);
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 1 || timeout > 180)) throw new UsageError('--timeout must be 1-180 minutes');
  return {
    testCommand: flags.test,
    turnTimeoutMin: timeout,
    models: { claude: flags['claude-model'], codex: flags['codex-model'] },
    efforts: { claude: flags['claude-effort'], codex: flags['codex-effort'] },
    skipAuthCheck: flags['skip-auth-check'] === true,
  };
}

function resultJson(run: Run) {
  return {
    id: run.id,
    title: run.title,
    status: run.status,
    mode: run.config.mode,
    cwd: run.config.cwd,
    error: run.error,
    final: run.final,
    diff: run.diff,
    usage: run.usage,
    createdAt: run.createdAt,
    endedAt: run.endedAt,
  };
}

const normalizePath = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

function runsInside<T extends { cwd: string }>(runs: T[], root: string): T[] {
  const prefix = normalizePath(root);
  return runs.filter((r) => normalizePath(r.cwd) === prefix || normalizePath(r.cwd).startsWith(prefix + path.sep));
}

function statusColor(style: Style, status: string): (s: string) => string {
  if (status === 'done') return style.green;
  if (status === 'running') return style.cyan;
  if (status === 'cancelled') return style.yellow;
  return style.red;
}

const filesChanged = (diff?: string) => (diff?.match(/^diff --git/gm) ?? []).length;

function lockStateNote(state: string) {
  if (state === 'dead') return ' – process is gone; run `ai-duo unlock`';
  if (state === 'unknown') return ' – owner cannot be checked';
  return '';
}

function lockMark(state: string, marks: { ok: string; bad: string; warn: string }) {
  if (state === 'dead') return marks.bad;
  if (state === 'alive') return marks.ok;
  return marks.warn;
}

class Cli {
  readonly style: Style;
  constructor(
    readonly io: Io,
    readonly flags: Flags,
  ) {
    const color = !flags['no-color'] && !flags.json && !io.env.NO_COLOR && !!io.stderr.isTTY;
    this.style = makeStyle(color);
  }

  err(text: string) {
    this.io.stderr.write(`${text}\n`);
  }

  out(text: string) {
    this.io.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  json(value: unknown) {
    this.out(JSON.stringify(value, null, 2));
  }

  /** Report a service failure; returns the exit code. */
  failure(err: unknown): number {
    if (err instanceof UsageError || err instanceof DirectoryAccessError) {
      if (this.flags.json) this.json({ error: err.message, code: 'invalid' });
      this.err(this.style.red(err.message));
      this.err('Run `ai-duo --help` for usage.');
      return EXIT.usage;
    }
    if (err instanceof ServiceError) {
      if (this.flags.json) this.json({ error: err.message, code: err.code, ...(err.details.preflight && { preflight: err.details.preflight }) });
      this.err(this.style.red(err.message));
      return EXIT_FOR[err.code];
    }
    throw err;
  }

  /** Stream a run until it ends, answering decisions; returns the exit code. */
  async follow(start: (options: StartOptions) => Promise<RunHandle>): Promise<number> {
    const { io, flags, style } = this;
    const renderer = new ProgressRenderer((s) => io.stderr.write(s), { style, verbose: flags.verbose === true });
    const decisions = new DecisionController(
      {
        plan: oneOf('plan-decision', flags['plan-decision'], ['approve', 'stop'] as const),
        pairExtraRounds: count('pair-extra-rounds', flags['pair-extra-rounds']),
        interactive: !!io.stdin.isTTY,
      },
      {
        input: io.stdin,
        output: io.stderr,
        style,
        beforePrompt: () => renderer.flush(),
        onInterrupt: () => interrupt(),
      },
    );

    let handle: RunHandle | undefined;
    let interrupts = 0;
    const interrupt = () => {
      interrupts++;
      renderer.flush();
      if (interrupts === 1) {
        this.err(style.yellow('Stopping the run… (Ctrl+C again to quit at once)'));
        decisions.close();
        handle?.cancel(); // before the run started, cancelled right after start() returns
      } else {
        this.err(style.red('Quit without waiting: the agents may still be running and the repository lock stays until `ai-duo unlock`.'));
        process.exit(EXIT.cancelled);
      }
    };
    const removeInterrupt = io.onInterrupt(interrupt);

    try {
      if (!flags.quiet) this.err(style.dim('Routing and checking agents…'));
      try {
        handle = await start({
          onCreated: (run) => {
            if (!flags.quiet) this.err(style.dim(`Run ${run.id} · ${run.config.mode} · ${run.config.cwd}`));
          },
          onEvent: (e) => {
            if (!flags.quiet) renderer.event(e);
            decisions.onEvent(e);
          },
        });
      } catch (err) {
        return this.failure(err);
      }
      if (interrupts) handle.cancel();
      decisions.attach(handle);

      const run = await handle.done;
      decisions.close();
      renderer.flush();
      const code = this.finish(run);
      if (decisions.problem && code === EXIT.ok) {
        this.err(style.red(decisions.problem));
        return EXIT.failed;
      }
      return code;
    } finally {
      removeInterrupt();
    }
  }

  finish(run: Run): number {
    const { style, flags } = this;
    let code: number = EXIT.failed;
    let mark = style.red('✗ error');
    if (run.status === 'done') {
      code = EXIT.ok;
      mark = style.green('✓ done');
    } else if (run.status === 'cancelled') {
      code = EXIT.cancelled;
      mark = style.yellow('■ cancelled');
    }
    if (flags.json) this.json(resultJson(run));
    else if (run.final) this.out(run.final);
    const changed = run.config.mode === 'code' && run.diff !== undefined ? ` · ${filesChanged(run.diff)} file(s) changed, not committed` : '';
    const usage = run.usage ? ` · ${formatUsage(run.usage)}` : '';
    const detail = style.dim(`${changed}${usage}`);
    this.err(`\n${mark}${detail}`);
    if (run.error) this.err(style.red(run.error));
    this.err(style.dim(`ai-duo show ${run.id}${changed ? ' --diff' : ''}   ·   ai-duo continue ${run.id} "…"`));
    return code;
  }

  /** --plan-decision=approve starts Code, which needs Git: refuse before planning anything. */
  private async assertApprovable(mode: Mode, cwd: string) {
    if (mode === 'plan' && this.flags['plan-decision'] === 'approve' && existsSync(cwd) && !(await isGitRepo(cwd))) {
      throw new UsageError(`${gitRequiredMessage(cwd)} Without Git, drop --plan-decision=approve to get the plan only.`);
    }
  }

  async run(positionals: string[]): Promise<number> {
    const { flags, io } = this;
    let prompt = positionals.join(' ').trim();
    if (prompt === '-') prompt = (await readStdin(io.stdin)).trim();
    if (!prompt) throw new UsageError('Missing request: ai-duo run "<request>" (or `-` to read it from stdin)');
    const mode = oneOf('mode', flags.mode, ['code', 'plan'] as const) ?? 'code';
    const cwd = authorizeDirectory(path.resolve(io.cwd, flags.cwd ?? '.'));
    const request: RunRequest = { ...requestFrom(flags), mode, prompt, cwd };
    await this.assertApprovable(mode, cwd);
    await seedPrompts();
    return this.follow((options) => service.start(request, options));
  }

  async continue(positionals: string[]): Promise<number> {
    const { flags, io } = this;
    const [id, ...rest] = positionals;
    if (!id) throw new UsageError('Missing run id: ai-duo continue <run-id> "<request>"');
    let prompt = rest.join(' ').trim();
    if (prompt === '-') prompt = (await readStdin(io.stdin)).trim();
    if (!prompt) throw new UsageError('Missing request: ai-duo continue <run-id> "<request>"');
    if (flags.cwd) throw new UsageError('--cwd cannot be used with continue: a run stays in its folder');
    const previous = await service.get(id);
    if (!previous) throw new ServiceError('not_found', `Run not found: ${id}`);
    const current = previous.config.mode;
    const mode: Mode = oneOf('mode', flags.mode, ['code', 'plan'] as const) ?? (current === 'plan' ? 'plan' : 'code');
    await this.assertApprovable(mode, authorizeDirectory(previous.config.cwd));
    await seedPrompts();
    return this.follow((options) => service.continue(id, { ...requestFrom(flags), mode, prompt }, options));
  }

  async runs(): Promise<number> {
    const { flags, io, style } = this;
    const limit = count('limit', flags.limit) ?? 20;
    let runs = await service.list();
    let scope = 'all folders';
    if (!flags.all) {
      const here = path.resolve(io.cwd, flags.cwd ?? '.');
      const top = await gitToplevel(here);
      const root = top ? path.resolve(top) : here;
      runs = runsInside(runs, root);
      scope = root;
    }
    runs = runs.slice(0, limit || undefined);
    if (flags.json) {
      this.json(runs);
      return EXIT.ok;
    }
    if (!runs.length) {
      this.err(`No runs in ${scope}${flags.all ? '' : ' (use --all for every folder)'}.`);
      return EXIT.ok;
    }
    this.err(style.dim(`Runs in ${scope}:`));
    for (const r of runs) {
      const padded = r.status.padEnd(9);
      const status = statusColor(style, r.status)(padded);
      const title = (r.title || r.prompt).split('\n')[0].slice(0, 70);
      const where = flags.all ? style.dim(`  ${r.cwd}`) : '';
      this.out(`${r.id}  ${status}  ${String(r.mode).padEnd(4)}  ${title}${where}`);
    }
    return EXIT.ok;
  }

  async show(positionals: string[]): Promise<number> {
    const { flags, style } = this;
    const [id] = positionals;
    if (!id) throw new UsageError('Missing run id: ai-duo show <run-id>');
    const run = await service.get(id);
    if (!run) throw new ServiceError('not_found', `Run not found: ${id}`);
    if (flags.json) this.json(run);
    else if (flags.diff) this.out(run.diff || '(no changes)');
    else this.out(transcript(run, style, { verbose: flags.verbose === true }));
    return EXIT.ok;
  }

  async doctor(): Promise<number> {
    const { flags, io } = this;
    const cwd = authorizeDirectory(path.resolve(io.cwd, flags.cwd ?? '.'));
    const folderExists = existsSync(cwd);
    const promptsReady = await seedPrompts().then(() => null, (err: Error) => err.message);
    const prompts = await readdir(paths.promptsDir).catch(() => [] as string[]);
    const runsCount = (await readdir(paths.dataDir).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).length;
    const top = folderExists ? await gitToplevel(cwd) : null;
    const git = top && path.resolve(top);
    const gitVersion = readGitVersion();
    const report = await service.preflight(['claude', 'codex'] as AgentName[], folderExists ? cwd : io.cwd, flags['skip-auth-check'] === true);
    const target = folderExists ? await lockTarget(cwd).catch(() => undefined) : undefined;
    const owner = target ? await readLockOwner(target.file) : undefined;
    const locks = await listLocks();

    if (flags.json) {
      this.json(doctorJson({ cwd, git, gitVersion, promptsReady, owner, report, locks }));
    } else {
      this.doctorText({ cwd, git, gitVersion, promptsReady, prompts, runsCount, owner, target, report, locks });
    }
    return report.ok && gitVersion && !promptsReady ? EXIT.ok : EXIT.preflight;
  }

  private doctorText(d: {
    cwd: string;
    git: string | null;
    gitVersion: string | null;
    promptsReady: string | null;
    prompts: string[];
    runsCount: number;
    owner: Awaited<ReturnType<typeof readLockOwner>> | undefined;
    target: Awaited<ReturnType<typeof lockTarget>> | undefined;
    report: Awaited<ReturnType<RunService['preflight']>>;
    locks: Awaited<ReturnType<typeof listLocks>>;
  }) {
    const { style } = this;
    const { cwd, git, gitVersion, promptsReady, owner, target, report, locks } = d;
    const ok = style.green('✓');
    const bad = style.red('✗');
    const warn = style.yellow('!');
    const row = (mark: string, label: string, value: string) => this.out(`${mark} ${label.padEnd(12)} ${value}`);
    const folderExists = existsSync(cwd);
    const templates = style.dim(`(${d.prompts.filter((p) => p.endsWith('.md')).length} templates)`);
    const marks = { ok, bad, warn };
    const saved = style.dim(`(${d.runsCount} saved)`);
    row(ok, 'Node', process.version);
    row(gitVersion ? ok : bad, 'Git', gitVersion ?? 'not found on PATH (Code mode needs it)');
    row(ok, 'Runs', `${paths.dataDir} ${saved}`);
    row(promptsReady ? bad : ok, 'Prompts', promptsReady ?? `${paths.promptsDir} ${templates}`);
    row(folderExists ? ok : bad, 'Folder', folderExists ? `${cwd}${this.gitNote(git)}` : `${cwd} does not exist`);
    this.lockRow(row, { owner, target }, marks);
    for (const check of report.checks) this.agentRow(check, this.flags['skip-auth-check'] === true);
    this.otherLocks(locks.filter((lock) => lock.file !== target?.file), marks);
  }

  private lockRow(
    row: (mark: string, label: string, value: string) => void,
    lock: { owner: Awaited<ReturnType<typeof readLockOwner>> | undefined; target: unknown },
    marks: { ok: string; bad: string; warn: string },
  ) {
    const { owner, target } = lock;
    if (owner !== undefined) {
      const state = ownerState(owner);
      row(state === 'dead' ? marks.bad : marks.warn, 'Lock', owner ? `${describeOwner(owner)}${lockStateNote(state)}` : 'unreadable lock file');
    } else if (target) row(marks.ok, 'Lock', 'free');
  }

  private otherLocks(others: Awaited<ReturnType<typeof listLocks>>, marks: { ok: string; bad: string; warn: string }) {
    if (!others.length) return;
    this.out(this.style.dim('\nOther repository locks:'));
    for (const lock of others) {
      const mark = lockMark(lock.state, marks);
      const detail = lock.owner ? `${lock.owner.root} · ${describeOwner(lock.owner)} · ${lock.state}` : `${lock.file} (unreadable)`;
      this.out(`  ${mark} ${detail}`);
    }
  }

  private gitNote(git: string | null) {
    const { style } = this;
    return git ? style.dim(` · git: ${git}`) : style.dim(' · not a Git repository (Plan only)');
  }

  private agentRow(check: AgentCheck, skipAuth: boolean) {
    const { style } = this;
    const name = check.agent === 'claude' ? 'Claude CLI' : 'Codex CLI';
    if (check.error) {
      this.out(`${style.red('✗')} ${name.padEnd(12)} ${check.error}`);
      return;
    }
    const { mark, login } = this.authDisplay(check.auth, skipAuth);
    const location = style.dim(`· ${check.path}`);
    this.out(`${mark} ${name.padEnd(12)} ${check.version} ${location} · ${login}`);
    if (check.authError) this.out(style.dim(`  ${check.authError}`));
  }

  private authDisplay(auth: AgentCheck['auth'], skipAuth: boolean) {
    const { style } = this;
    if (auth === 'ok') return { mark: style.green('✓'), login: style.green('logged in (subscription)') };
    if (auth === 'unknown') {
      const hint = skipAuth ? ' (--skip-auth-check)' : ' – runs need --skip-auth-check';
      return { mark: style.yellow('!'), login: style.yellow(`login not verified${hint}`) };
    }
    return { mark: style.red('✗'), login: style.red('login problem') };
  }


  async unlock(positionals: string[]): Promise<number> {
    const { flags, io, style } = this;
    const cwd = authorizeDirectory(path.resolve(io.cwd, positionals[0] ?? flags.cwd ?? '.'));
    if (!existsSync(cwd)) throw new UsageError(`Folder not found: ${cwd}`);
    const result = await unlockRepo(cwd, { force: flags.force === true });
    if (flags.json) this.json(result);
    if (result.result === 'none') {
      this.err(`No lock for ${result.target.root}.`);
      return EXIT.ok;
    }
    const who = result.owner ? describeOwner(result.owner) : 'an unreadable lock file';
    if (result.result === 'refused') {
      const why = result.state === 'alive' ? 'that process is still running' : 'its owner cannot be checked from here';
      this.err(style.red(`Not unlocking ${result.target.root}: held by ${who}, and ${why}.`));
      this.err(`If you are sure no agent is still working there (for example the PID now belongs to another program), run \`ai-duo unlock "${result.target.root}" --force\`.`);
      return EXIT.locked;
    }
    const held = style.dim(`(was held by ${who})`);
    this.err(`${style.green('Unlocked')} ${result.target.root} ${held}`);
    return EXIT.ok;
  }
}

/** Parse argv and run one command; returns the exit code. */
export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    io.stderr.write(`${(err as Error).message}\nRun \`ai-duo --help\` for usage.\n`);
    return EXIT.usage;
  }
  const { values: flags, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (flags.version) {
    io.stdout.write(`${VERSION}\n`);
    return EXIT.ok;
  }
  if (flags.help || !command || command === 'help') {
    (command || flags.help ? io.stdout : io.stderr).write(HELP);
    return command || flags.help ? EXIT.ok : EXIT.usage;
  }
  const cli = new Cli(io, flags);
  try {
    switch (command) {
      case 'run':
        return await cli.run(rest);
      case 'continue':
        return await cli.continue(rest);
      case 'runs':
        return await cli.runs();
      case 'show':
        return await cli.show(rest);
      case 'doctor':
        return await cli.doctor();
      case 'unlock':
        return await cli.unlock(rest);
      default:
        throw new UsageError(`Unknown command: ${command}`);
    }
  } catch (err) {
    return cli.failure(err);
  }
}
