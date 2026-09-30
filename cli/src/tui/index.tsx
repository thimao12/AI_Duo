import { execFile } from 'node:child_process';
import { render } from 'ink';
import { gitExecutable } from '../../../server/src/git.ts';
import { RunService } from '../../../server/src/service.ts';
import { App } from './App.tsx';
import { historyFile, loadHistory } from './history.ts';
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

/**
 * Full-screen-ish interactive chat: composer, streamed thread, slash commands and panels.
 * Resolves with the exit code once the user quits; the terminal is restored by then.
 */
export async function startTui(options: TuiOptions): Promise<number> {
  const service: ChatService = options.service ?? new RunService({ app: 'cli' });
  const file = options.historyFile ?? historyFile();
  const [branch, history] = await Promise.all([gitBranch(options.cwd), loadHistory(file)]);
  const instance = render(
    <App
      service={service}
      cwd={options.cwd}
      branch={branch}
      version={options.version ?? '0.1.0'}
      history={history}
      historyFile={file}
      skipPreflight={options.skipPreflight}
    />,
    { stdin: options.stdin, stdout: options.stdout, exitOnCtrlC: false, patchConsole: false, kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] } },
  );
  await instance.waitUntilExit();
  await stopRuns(service);
  return 0;
}
