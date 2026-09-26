import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths.ts';
import type { Run } from './types.ts';

const DIR = paths.dataDir;
await mkdir(DIR, { recursive: true });

const file = (id: string) => path.join(DIR, `${id}.json`);
const saves = new Map<string, Promise<void>>();
let tempSequence = 0;

const retryableRenameErrors = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(from: string, to: string) {
  for (let retry = 0; ; retry++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!retryableRenameErrors.has(code ?? '') || retry === 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (retry + 1)));
    }
  }
}

export async function saveRun(run: Run) {
  const contents = JSON.stringify(run);
  const previous = saves.get(run.id) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const tmp = path.join(DIR, `${run.id}.${process.pid}.${++tempSequence}.tmp`);
    try {
      await writeFile(tmp, contents, 'utf8');
      await renameWithRetry(tmp, file(run.id));
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  });
  saves.set(run.id, current);
  try {
    await current;
  } finally {
    if (saves.get(run.id) === current) saves.delete(run.id);
  }
}

export async function loadRun(id: string): Promise<Run | undefined> {
  if (!/^[\w-]+$/.test(id)) return undefined;
  try {
    const run: Run = JSON.parse(await readFile(file(id), 'utf8'));
    // A run or message still marked "running" on disk means the server died mid-run.
    if (run.status === 'running') {
      run.status = 'error';
      run.error = 'Interrupted (server restarted)';
    }
    for (const message of run.messages) {
      if (message.status !== 'running') continue;
      message.status = 'error';
      message.endedAt = Date.now();
      message.parts.push({ kind: 'error', content: 'Interrupted (server restarted)' });
    }
    return run;
  } catch {
    return undefined;
  }
}

export interface RunSummary {
  id: string;
  title?: string;
  mode: Run['config']['mode'];
  prompt: string;
  /** Working directory the run belongs to (groups runs by project). */
  cwd: string;
  status: Run['status'];
  createdAt: number;
  claudeLimits?: Run['claudeLimits'];
}

export async function listRuns(): Promise<RunSummary[]> {
  const names = (await readdir(DIR)).filter((n) => n.endsWith('.json'));
  const out: RunSummary[] = [];
  for (const n of names) {
    const run = await loadRun(n.slice(0, -5));
    if (run) out.push({ id: run.id, title: run.title, mode: run.config.mode, prompt: run.config.prompt.slice(0, 2000), cwd: run.config.cwd, status: run.status, createdAt: run.createdAt, claudeLimits: run.claudeLimits });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteRun(id: string): Promise<boolean> {
  if (!/^[\w-]+$/.test(id) || !(await loadRun(id))) return false;
  await rm(file(id));
  await rm(path.join(DIR, 'images', id), { recursive: true, force: true });
  return true;
}
