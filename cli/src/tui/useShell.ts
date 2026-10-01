import { useEffect, useRef, useState } from 'react';
import { inputHint, isDirectoryChange, runShell, type ShellHandle } from './shell.ts';
import type { ShellItem } from './ShellView.tsx';
import type { ThreadItem } from './thread.ts';

export interface ShellApi {
  /** The command that is running now, with its output so far. */
  live: ShellItem | null;
  running: boolean;
  /** Starts a command; returns an error message when it cannot start, else null. */
  run(command: string): string | null;
  /** Kills the running command and everything it started. */
  kill(): void;
}

type Notice = (tone: 'info' | 'warn' | 'error', text: string) => void;

/**
 * Shell mode of the chat: runs the typed command in cwd, shows its output as a live thread item and
 * moves the finished item into the thread. The output never goes to the agents. Kills the command on unmount.
 */
export function useShell(cwd: string, push: (item: ThreadItem) => void, notice: Notice): ShellApi {
  const [live, setLive] = useState<ShellItem | null>(null);
  const job = useRef<ShellHandle | null>(null);
  const mounted = useRef(true);
  const counter = useRef(0);
  const hinted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      job.current?.kill();
      job.current = null;
    };
  }, []);

  const run = (command: string): string | null => {
    if (job.current) return 'A shell command is still running. Wait for it, or press Ctrl+C to stop it.';
    if (!hinted.current && isDirectoryChange(command)) {
      hinted.current = true;
      notice('info', `Each ! command runs in ${cwd}; use ai-duo -C <dir> to change folder.`);
    }
    const id = `shell-${++counter.current}`;
    const started = Date.now();
    const item = (patch: Partial<ShellItem>): ShellItem => ({ id, kind: 'shell', command, state: 'running', code: null, ms: Date.now() - started, lines: [], ...patch });
    setLive(item({}));
    const handle = runShell(command, {
      cwd,
      onUpdate: (lines) => {
        if (mounted.current) setLive(item({ lines }));
      },
    });
    job.current = handle;
    void handle.done.then((result) => {
      if (job.current === handle) job.current = null;
      if (!mounted.current) return;
      const failed = result.state === 'exited' && result.code !== 0;
      setLive(null);
      push(item({ state: result.state, code: result.code, ms: result.ms, lines: result.lines, error: result.error, hint: failed ? inputHint(result.lines) : undefined }));
    });
    return null;
  };

  const kill = () => job.current?.kill();

  return { live, running: live !== null, run, kill };
}
