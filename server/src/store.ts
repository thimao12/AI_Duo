import { mkdir, readdir } from 'node:fs/promises';
import { isDataId, readRunFile, removeRunFiles, requireDataId, writeRunFile } from './data-path.ts';
import type { AgentName } from './agents/types.ts';
import { runsActiveElsewhere } from './lock.ts';
import { paths } from './paths.ts';
import type { Run } from './types.ts';

const DIR = paths.dataDir;
await mkdir(DIR, { recursive: true });

const saves = new Map<string, Promise<void>>();

export async function saveRun(run: Run) {
  const id = requireDataId(run.id);
  const contents = JSON.stringify(run);
  const previous = saves.get(id) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => writeRunFile(id, contents));
  saves.set(id, current);
  try {
    await current;
  } finally {
    if (saves.get(id) === current) saves.delete(id);
  }
}

/** `elsewhere`: runs active in other processes, when the caller already looked them up. */
export async function loadRun(id: string, elsewhere?: Map<string, unknown>): Promise<Run | undefined> {
  if (!isDataId(id)) return undefined;
  try {
    const run: Run = JSON.parse(await readRunFile(id));
    if (run.id !== id) return undefined;
    // Another AI Duo process (CLI, desktop) is running it and checkpoints it here.
    if (run.status === 'running' && (elsewhere ?? (await runsActiveElsewhere())).has(run.id)) return run;
    // Otherwise a run or message still marked "running" on disk means the server died mid-run.
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

/** The agent a run is mostly about; records saved before roles existed derive it from coder/judge. */
export function runAgent(config: Run['config']): AgentName {
  const agent = config.mode === 'debate' ? config.judge : config.coder;
  return agent === 'codex' ? 'codex' : 'claude';
}

export function summarizeRun(run: Run): RunSummary {
  return { id: run.id, title: run.title, mode: run.config.mode, agent: runAgent(run.config), prompt: run.config.prompt.slice(0, 2000), cwd: run.config.cwd, status: run.status, createdAt: run.createdAt, claudeLimits: run.claudeLimits };
}

export interface RunSummary {
  id: string;
  agent: AgentName;
  title?: string;
  mode: Run['config']['mode'];
  prompt: string;
  /** Working directory the run belongs to (groups runs by project). */
  cwd: string;
  status: Run['status'];
  createdAt: number;
  claudeLimits?: NonNullable<Run['claudeLimits']>;
}

export async function listRuns(): Promise<RunSummary[]> {
  const names = (await readdir(DIR)).filter((n) => n.endsWith('.json'));
  const elsewhere = await runsActiveElsewhere();
  const loaded = await Promise.all(names.map((n) => loadRun(n.slice(0, -5), elsewhere)));
  const out: RunSummary[] = [];
  for (const run of loaded) {
    if (run) out.push(summarizeRun(run));
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteRun(id: string): Promise<boolean> {
  if (!isDataId(id) || !(await loadRun(id))) return false;
  await removeRunFiles(id);
  return true;
}
