import { execFile } from 'node:child_process';
import { render } from 'ink';
import { gitExecutable } from '../../../server/src/git.ts';
import { RunService } from '../../../server/src/service.ts';
import { App } from './App.tsx';
import { historyFile, loadHistory } from './history.ts';
import { AltScreen, guardProcess } from './screen.ts';
import type { ChatService } from './useSession.ts';

export interface TuiOptions {
  cwd: string;
  service?: ChatService;
  version?: string;
  /** Prompt history file; defaults to the app data folder. */
  historyFile?: string;
  skipPreflight?: boolean;
  /** Terminal streams; default to the process's own (tests pass fakes). */
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** 'fullscreen' (default): alternate screen, restored on every exit path. 'inline': in the scrollback. */
  screen?: 'fullscreen' | 'inline';
}

/** Current branch of `cwd`, or undefined when it is not a repository (or git is slow). */
function gitBranch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(gitExecutable(), ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 2000, windowsHide: true }, (err, stdout) => {
      const branch = stdout.trim();
      resolve(err || !branch ? undefined : branch);
    });
  });
}

const QUIT_WAIT_MS = 5000;

/** Stop any run still going and wait (briefly) until it has saved and released its lock. */
async function stopRuns(service: ChatService): Promise<void> {
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, QUIT_WAIT_MS).unref());
  await Promise.race([service.abortAll(), timeout]);
}

interface RenderSetup {
  options: TuiOptions;
  service: ChatService;
  file: string;
  branch: string | undefined;
  history: string[];
  screen: 'fullscreen' | 'inline';
  onRunChange: (id: string | undefined) => void;
}

function mount({ options, service, file, branch, history, screen, onRunChange }: Readonly<RenderSetup>) {
  return render(
    <App
      service={service}
      cwd={options.cwd}
      branch={branch}
      version={options.version ?? '0.1.0'}
      history={history}
      historyFile={file}
      skipPreflight={options.skipPreflight}
      screen={screen}
      onRunChange={onRunChange}
    />,
    // Kitty keyboard reports stay off: Windows Terminal / VS Code would send text as CSI-u, which breaks IME
    // composition (Vietnamese Telex/Unikey). New line is Alt+Enter (ESC CR), Ctrl+J or a trailing backslash.
    // Ink merges these over its defaults, so an undefined stdin/stdout would replace process.stdin/stdout.
    // Full screen: the caller checked for a terminal, so Ink must not fall back to its CI (last-frame-only) mode.
    {
      ...(options.stdin && { stdin: options.stdin }),
      ...(options.stdout && { stdout: options.stdout }),
      ...(screen === 'fullscreen' && { interactive: true }),
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
}

/**
 * Interactive chat: composer, streamed thread, slash commands and panels. Full screen by default (alternate
 * screen, like vim); `screen: 'inline'` keeps the thread in the terminal's scrollback.
 * Resolves with the exit code once the user quits; the terminal is restored by then, and an error
 * is rethrown only after the alternate screen was left, so the caller's message stays visible.
 */
export async function startTui(options: TuiOptions): Promise<number> {
  const service: ChatService = options.service ?? new RunService({ app: 'cli' });
  const file = options.historyFile ?? historyFile();
  const screen = options.screen ?? 'fullscreen';
  const stdout = options.stdout ?? process.stdout;
  const [branch, history] = await Promise.all([gitBranch(options.cwd), loadHistory(file)]);
  const alt = screen === 'fullscreen' ? new AltScreen(stdout, options.stdin ?? process.stdin) : undefined;
  let runId: string | undefined;
  let disposeGuard: (() => void) | undefined;
  try {
    alt?.enter();
    const instance = mount({ options, service, file, branch, history, screen, onRunChange: (id) => {
        runId = id;
      },
    });
    if (alt) disposeGuard = guardProcess({ screen: alt, unmount: () => instance.unmount(), stderr: process.stderr });
    await instance.waitUntilExit();
  } finally {
    disposeGuard?.();
    alt?.leave();
  }
  if (alt && runId) stdout.write(`Resume this session with /sessions in ai-duo (run ${runId}).
`);
  await stopRuns(service);
  return 0;
}
