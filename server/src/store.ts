import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths.ts';
import type { Run } from './types.ts';

const DIR = paths.dataDir;
await mkdir(DIR, { recursive: true });

const file = (id: string) => path.join(DIR, `${id}.json`);

export async function saveRun(run: Run) {
  const tmp = file(run.id) + '.tmp';
  await writeFile(tmp, JSON.stringify(run), 'utf8');
  await rename(tmp, file(run.id));
}

export async function loadRun(id: string): Promise<Run | undefined> {
  if (!/^[\w-]+$/.test(id)) return undefined;
  try {
    const run: Run = JSON.parse(await readFile(file(id), 'utf8'));
    // A run still marked "running" on disk means the server died mid-run.
    if (run.status === 'running') {
      run.status = 'error';
      run.error = 'Interrupted (server restarted)';
    }
    return run;
  } catch {
    return undefined;
  }
}

export interface RunSummary {
  id: string;
  mode: Run['config']['mode'];
  prompt: string;
  status: Run['status'];
  createdAt: number;
}

export async function listRuns(): Promise<RunSummary[]> {
  const names = (await readdir(DIR)).filter((n) => n.endsWith('.json'));
  const out: RunSummary[] = [];
  for (const n of names) {
    const run = await loadRun(n.slice(0, -5));
    if (run) out.push({ id: run.id, mode: run.config.mode, prompt: run.config.prompt.slice(0, 200), status: run.status, createdAt: run.createdAt });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
