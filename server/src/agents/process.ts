import { spawn, execFile, type ChildProcess } from 'node:child_process';

export interface SpawnJsonlOptions {
  cwd: string;
  stdin: string;
  signal: AbortSignal;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  onJson: (obj: any) => void;
  onRawLine: (line: string) => void;
}

export class AbortedError extends Error {
  constructor(msg = 'Cancelled') {
    super(msg);
  }
}

function killTree(pid: number | undefined, child?: ChildProcess): Promise<void> {
  if (!pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (err) => {
        if (err) child?.kill();
        resolve();
      });
    });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    return Promise.resolve();
  }
}

/**
 * Spawn a CLI that prints JSON Lines on stdout. The prompt goes through stdin so
 * we never have to quote it for the Windows command line.
 */
export function spawnJsonl(cmd: string, args: string[], o: SpawnJsonlOptions): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (o.signal.aborted) return reject(new AbortedError());

    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: o.env ?? process.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    let stderr = '';
    let buf = '';
    let settled = false;
    let childClosed = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
      fn();
    };

    const onAbort = () => {
      void killTree(child.pid, child).then(async () => {
        // A grandchild holding the pipes open must not keep the run (and its pair lock) alive.
        if (!childClosed) await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))]);
        finish(() => reject(new AbortedError()));
      });
    };
    o.signal.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      void killTree(child.pid, child);
      finish(() => reject(new Error(`${cmd} timed out after ${Math.round(o.timeoutMs / 1000)}s`)));
    }, o.timeoutMs);

    const handleLine = (line: string) => {
      const t = line.trim();
      if (!t) return;
      let obj: unknown;
      try {
        obj = JSON.parse(t);
      } catch {
        o.onRawLine(t);
        return;
      }
      try {
        o.onJson(obj);
      } catch (err) {
        o.onRawLine(`[parser error] ${(err as Error).message}: ${t.slice(0, 300)}`);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    child.on('error', (err) => finish(() => reject(new Error(`Failed to start ${cmd}: ${err.message}`))));
    child.on('close', (code) => {
      childClosed = true;
      resolveClosed();
      if (buf.trim()) handleLine(buf);
      finish(() => (o.signal.aborted ? reject(new AbortedError()) : resolve({ code: code ?? -1, stderr })));
    });

    child.stdin.on('error', () => {}); // child may exit before reading everything
    child.stdin.end(o.stdin, 'utf8');
  });
}
