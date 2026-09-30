/**
 * Terminal screen lifecycle for the full-screen chat.
 *
 * The alternate screen is entered and left here, not through Ink's `alternateScreen` option, so
 * that leaving is idempotent and ordered: Ink unmounts first (its last frame goes to the alternate
 * screen), then the primary screen comes back, and only then is anything printed (a fatal error,
 * the resume hint). Leaving twice would restore the saved cursor twice, so a flag guards it.
 */

export const ENTER_ALT_SCREEN = '\u001B[?1049h\u001B[2J\u001B[H';
export const LEAVE_ALT_SCREEN = '\u001B[?1049l';
export const SHOW_CURSOR = '\u001B[?25h';

type Writable = Pick<NodeJS.WriteStream, 'write'>;
type RawCapable = { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };

export class AltScreen {
  private active = false;

  constructor(
    private readonly stdout: Writable,
    private readonly stdin?: RawCapable,
  ) {}

  get entered(): boolean {
    return this.active;
  }

  enter(): void {
    if (this.active) return;
    this.active = true;
    this.put(ENTER_ALT_SCREEN);
  }

  /** Safe to call any number of times, from any exit path. */
  leave(): void {
    if (!this.active) return;
    this.active = false;
    this.put(LEAVE_ALT_SCREEN + SHOW_CURSOR);
    try {
      if (this.stdin?.isTTY) this.stdin.setRawMode?.(false);
    } catch {
      // the stream is already gone: nothing left to restore
    }
  }

  private put(data: string): void {
    try {
      this.stdout.write(data);
    } catch {
      // a destroyed stream during shutdown must not mask the real error
    }
  }
}

export interface GuardOptions {
  screen: AltScreen;
  /** Stops Ink (raw mode off, final frame written to the alternate screen). */
  unmount: () => void;
  /** Where a fatal error is printed, after the alternate screen was left. */
  stderr?: Writable;
  /** Terminates the process; injectable for tests. */
  exit?: (code: number) => void;
  /** Process object to listen on; injectable for tests. */
  proc?: NodeJS.Process;
}

const SIGNALS = [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
] as const;

const describeFatal = (reason: unknown): string => {
  if (reason instanceof Error) return reason.stack ?? reason.message;
  return String(reason);
};

/**
 * While the full-screen chat runs: an uncaught exception, an unhandled rejection or a terminating
 * signal leaves the alternate screen first, then prints the error and exits. Returns the disposer.
 */
export function guardProcess(options: Readonly<GuardOptions>): () => void {
  const { screen, unmount, stderr = process.stderr, exit = process.exit, proc = process } = options;
  const shutdown = () => {
    try {
      unmount();
    } catch {
      // still leave the alternate screen below
    }
    screen.leave();
  };
  const fatal = (reason: unknown) => {
    shutdown();
    try {
      stderr.write(`\n${describeFatal(reason)}\n`);
    } catch {
      // nowhere left to report to
    }
    exit(1);
  };
  const onSignal = (code: number) => () => {
    shutdown();
    exit(code);
  };
  const onExit = () => screen.leave();

  proc.on('uncaughtException', fatal);
  proc.on('unhandledRejection', fatal);
  proc.on('exit', onExit);
  const signalHandlers = SIGNALS.map(([name, code]) => [name, onSignal(code)] as const);
  for (const [name, handler] of signalHandlers) proc.on(name, handler);

  return () => {
    proc.off('uncaughtException', fatal);
    proc.off('unhandledRejection', fatal);
    proc.off('exit', onExit);
    for (const [name, handler] of signalHandlers) proc.off(name, handler);
  };
}
