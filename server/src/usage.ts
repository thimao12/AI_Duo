import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { RunSummary } from './store.ts';
import type { AgentUsage, UsageReport } from './types.ts';
import { buildWindow, fetchClaudeLive, fetchCodexLive, FIVE_HOUR_MINUTES, WEEK_MINUTES, type LiveDeps, type LiveResult } from './usage-live.ts';

export type { AgentUsage, UsageReport, UsageWindow } from './types.ts';


const TAIL_BYTES = 256 * 1024;
const MAX_FILES = 5;
const DAY_DEPTH = 3;
const NEWEST_PER_LEVEL = [2, 2, 3];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/* ---- Claude: newest saved rate-limit readings ---- */

function claudeUsage(runs: RunSummary[] | undefined, now: number): AgentUsage {
  const latest = [...(runs ?? [])].filter((run) => run.claudeLimits).sort((a, b) => b.createdAt - a.createdAt)[0];
  const usage: AgentUsage = { source: 'run-history' };
  if (!latest?.claudeLimits) return usage;
  const read = (type: string, minutes: number) => {
    const limit = latest.claudeLimits?.[type];
    const utilization = finite(limit?.utilization);
    return utilization === undefined ? undefined : buildWindow(utilization * 100, finite(limit?.resetsAt), minutes, now);
  };
  const fiveHour = read('five_hour', FIVE_HOUR_MINUTES);
  const weekly = read('seven_day', WEEK_MINUTES);
  if (fiveHour) usage.fiveHour = fiveHour;
  if (weekly) usage.weekly = weekly;
  usage.updatedAt = new Date(latest.createdAt).toISOString();
  return usage;
}

/* ---- Codex: rate limits in the newest session logs ---- */

const listDir = (dir: string) => readdir(dir).catch(() => [] as string[]);

/** Rollout files under sessions/YYYY/MM/DD, walking only the newest folders of each level. */
async function collectFiles(dir: string, depth: number): Promise<string[]> {
  const names = await listDir(dir);
  if (depth === DAY_DEPTH) return names.filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl')).map((n) => path.join(dir, n));
  const newest = names.sort().reverse().slice(0, NEWEST_PER_LEVEL[depth]);
  return (await Promise.all(newest.map((n) => collectFiles(path.join(dir, n), depth + 1)))).flat();
}

async function readTail(file: string): Promise<{ text: string; mtimeMs: number } | undefined> {
  try {
    const handle = await open(file, 'r');
    try {
      const { size, mtimeMs } = await handle.stat();
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const text = buffer.toString('utf8');
      // A tail cut mid-line starts with a partial line; drop it.
      return { text: size > length ? text.slice(text.indexOf('\n') + 1) : text, mtimeMs };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

interface CodexSnapshot { primary?: unknown; secondary?: unknown; timestamp?: string }

function parseLine(line: string): CodexSnapshot | undefined {
  if (!line.includes('"rate_limits"')) return undefined;
  try {
    const event: unknown = JSON.parse(line);
    const payload = isRecord(event) ? event.payload : undefined;
    if (!isRecord(payload) || payload.type !== 'token_count' || !isRecord(payload.rate_limits)) return undefined;
    // Some events (e.g. limit_id "premium") carry no windows at all; keep looking for one that does.
    if (!isRecord(payload.rate_limits.primary) && !isRecord(payload.rate_limits.secondary)) return undefined;
    const timestamp = isRecord(event) && typeof event.timestamp === 'string' ? event.timestamp : undefined;
    return { primary: payload.rate_limits.primary, secondary: payload.rate_limits.secondary, timestamp };
  } catch {
    return undefined;
  }
}

function lastSnapshot(text: string): CodexSnapshot | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const snapshot = parseLine(lines[i]);
    if (snapshot) return snapshot;
  }
  return undefined;
}

/** Slot a raw limit into five-hour or weekly by its window length. */
function assignLimit(usage: AgentUsage, raw: unknown, now: number) {
  if (!isRecord(raw)) return;
  const minutes = finite(raw.window_minutes);
  if (minutes === undefined) return;
  const window = buildWindow(finite(raw.used_percent), finite(raw.resets_at), minutes, now);
  if (!window) return;
  if (minutes === FIVE_HOUR_MINUTES) usage.fiveHour = window;
  else if (minutes === WEEK_MINUTES) usage.weekly = window;
}

async function codexUsage(now: number): Promise<AgentUsage> {
  const usage: AgentUsage = { source: 'codex-session-log' };
  const root = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions');
  const files = (await collectFiles(root, 0)).sort((a, b) => path.basename(b).localeCompare(path.basename(a))).slice(0, MAX_FILES);
  const tails = await Promise.all(files.map(readTail));
  for (const tail of tails) {
    const snapshot = tail && lastSnapshot(tail.text);
    if (!tail || !snapshot) continue;
    assignLimit(usage, snapshot.primary, now);
    assignLimit(usage, snapshot.secondary, now);
    const at = snapshot.timestamp ? Date.parse(snapshot.timestamp) : tail.mtimeMs;
    usage.updatedAt = new Date(Number.isFinite(at) ? at : tail.mtimeMs).toISOString();
    break;
  }
  return usage;
}

export interface UsageOptions {
  /** Bypass the live cache. */
  force?: boolean;
  /** False skips the live queries and reads only what the CLIs left on disk. */
  live?: boolean;
  /** Test hooks for the live queries. */
  deps?: LiveDeps;
}

/** Live numbers win; on failure the disk data stays, flagged with why live is missing. */
function withLive(fallback: AgentUsage, live: LiveResult): AgentUsage {
  if (live.ok) return live.usage;
  const hasData = Boolean(fallback.fiveHour || fallback.weekly);
  const usage: AgentUsage = { ...fallback, live: false };
  if (live.error === 'needsLogin' || !hasData) usage.error = live.error;
  return usage;
}

/** Plan usage windows of both agents: asked live when possible, else from data the CLIs left on disk; never calls a model. */
export async function getUsage(runs?: RunSummary[], now = Date.now(), opts: UsageOptions = {}): Promise<UsageReport> {
  const deps: LiveDeps = { ...opts.deps, force: opts.force };
  const skipped: LiveResult = { ok: false, error: 'unavailable' };
  const [claudeLive, codexLive, codex] = await Promise.all([
    opts.live === false ? skipped : fetchClaudeLive(deps),
    opts.live === false ? skipped : fetchCodexLive(deps),
    codexUsage(now),
  ]);
  const claude = claudeUsage(runs, now);
  if (opts.live === false) return { claude, codex };
  return { claude: withLive(claude, claudeLive), codex: withLive(codex, codexLive) };
}
