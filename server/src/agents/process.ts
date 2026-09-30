import { spawn, execFile, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export interface SpawnJsonlOptions {
  cwd: string;
  stdin: string;
  signal: AbortSignal;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  onJson: (obj: any) => void;
  onRawLine: (line: string) => void;
}

export const MAX_JSONL_LINE_LENGTH = 64 * 1024 * 1024;

export class JsonlDecoder {
  private buf = '';

  constructor(
    private readonly onJson: (obj: any) => void,
    private readonly onRawLine: (line: string) => void,
    private readonly maxLineLength = MAX_JSONL_LINE_LENGTH,
  ) {}

  push(chunk: string) {
    let start = 0;
    let newline: number;
    while ((newline = chunk.indexOf('\n', start)) >= 0) {
      this.buf += chunk.slice(start, newline);
      this.checkLength();
      this.handleLine(this.buf);
      this.buf = '';
      start = newline + 1;
    }
    this.buf += chunk.slice(start);
    this.checkLength();
  }

  end() {
    if (this.buf.trim()) this.handleLine(this.buf);
    this.buf = '';
  }

  private checkLength() {
    if (this.buf.length > this.maxLineLength) throw new Error('Dòng JSONL vượt 64 MB – output bất thường');
  }

  private handleLine(line: string) {
    const t = line.trim();
    if (!t) return;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      this.onRawLine(t);
      return;
    }
    try {
      this.onJson(obj);
    } catch (err) {
      this.onRawLine(`[parser error] ${(err as Error).message}: ${t.slice(0, 300)}`);
    }
  }
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
      execFile(path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], (err) => {
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

    const decoder = new JsonlDecoder(o.onJson, o.onRawLine);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      try {
        decoder.push(chunk);
      } catch (err) {
        void killTree(child.pid, child);
        finish(() => reject(err));
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
      try {
        decoder.end();
      } catch (err) {
        finish(() => reject(err));
        return;
      }
      finish(() => (o.signal.aborted ? reject(new AbortedError()) : resolve({ code: code ?? -1, stderr })));
    });

    child.stdin.on('error', () => {}); // child may exit before reading everything
    child.stdin.end(o.stdin, 'utf8');
  });
}
