import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { readFile as nodeReadFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { agentEnv } from './agents/billing.ts';
import { resolveBin, type ResolvedBin } from './agents/bins.ts';
import type { AgentName } from './agents/types.ts';
import type { AgentUsage, UsageResetCredit, UsageWindow } from './types.ts';

/** Live plan usage, straight from the account behind each CLI login. */

export const FIVE_HOUR_MINUTES = 300;
export const WEEK_MINUTES = 10080;

const CACHE_MS = 30_000;
const FAILURE_CACHE_MS = 5_000;
const TIMEOUT_MS = 8_000;
// Fixed host and path: the URL is never built from input.
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_BETA = 'oauth-2025-04-20';

export type LiveResult = { ok: true; usage: AgentUsage } | { ok: false; error: 'needsLogin' | 'unavailable' };

export interface LiveDeps {
  now?: () => number;
  /** Bypass the 30 second cache. */
  force?: boolean;
  timeoutMs?: number;
  spawn?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: any; windowsHide: boolean }) => ChildProcess;
  resolveBin?: (name: AgentName) => ResolvedBin;
  fetch?: typeof fetch;
  readFile?: (file: string) => Promise<string>;
  /** Folder holding .credentials.json; defaults to CLAUDE_CONFIG_DIR or ~/.claude. */
  claudeConfigDir?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export function buildWindow(usedPercent: number | undefined, resetsAtSeconds: number | undefined, windowMinutes: number, now: number): UsageWindow | undefined {
  if (usedPercent === undefined) return undefined;
  const window: UsageWindow = { usedPercent: Math.round(usedPercent * 10) / 10, windowMinutes };
  if (resetsAtSeconds !== undefined) {
    window.resetsAt = new Date(resetsAtSeconds * 1000).toISOString();
    if (resetsAtSeconds * 1000 < now) window.stale = true;
  }
  return window;
}

/** Reject after `ms`, running `onTimeout` (kill the process, abort the request). */
function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error('timeout'));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/* ---- Cache with request coalescing ---- */

const cache = new Map<string, { at: number; result: LiveResult }>();
const inflight = new Map<string, Promise<LiveResult>>();

export function clearLiveCache(): void {
  cache.clear();
  inflight.clear();
}

async function cachedLive(agent: string, deps: LiveDeps, load: () => Promise<LiveResult>): Promise<LiveResult> {
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(agent);
  if (hit && !deps.force && now - hit.at < (hit.result.ok ? CACHE_MS : FAILURE_CACHE_MS)) return hit.result;
  const pending = inflight.get(agent);
  if (pending) return pending;
  const started = load()
    .catch((): LiveResult => ({ ok: false, error: 'unavailable' }))
    .then((result) => {
      cache.set(agent, { at: (deps.now ?? Date.now)(), result });
      return result;
    })
    .finally(() => inflight.delete(agent));
  inflight.set(agent, started);
  return started;
}

/* ---- Codex: JSON-RPC over `codex app-server` ---- */

class RpcError extends Error {
  constructor(readonly needsLogin: boolean) {
    super('rpc');
  }
}

const AUTH_MESSAGE = /log ?in|sign ?in|auth|token|unauthori[sz]ed/i;

/** One line of app-server output; anything that is not a JSON-RPC object is ignored. */
function parseRpcLine(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const rpc = (message: Record<string, unknown>) => `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`;

function rpcFailure(message: Record<string, unknown>): RpcError {
  const error = isRecord(message.error) ? message.error : {};
  return new RpcError(AUTH_MESSAGE.test(typeof error.message === 'string' ? error.message : ''));
}

/** Runs initialize, initialized, then account/rateLimits/read; resolves with the read's result. */
function askAppServer(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const send = (message: Record<string, unknown>) => child.stdin?.write(rpc(message));
    const onMessage = (message: Record<string, unknown>) => {
      if (message.error !== undefined && (message.id === 1 || message.id === 2)) return reject(rpcFailure(message));
      if (message.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read', params: null });
      } else if (message.id === 2) resolve(message.result);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const message = parseRpcLine(line.trim());
        if (message) onMessage(message);
      }
    });
    child.stdin?.on('error', () => reject(new Error('stdin')));
    child.on('error', () => reject(new Error('spawn')));
    child.on('exit', () => reject(new Error('exit')));
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ai-duo', title: 'AI Duo', version: '1.0.0' } } });
  });
}

function windowFrom(raw: unknown, now: number): { minutes: number; window: UsageWindow } | undefined {
  if (!isRecord(raw)) return undefined;
  const minutes = finite(raw.windowDurationMins);
  if (minutes === undefined) return undefined;
  const window = buildWindow(finite(raw.usedPercent), finite(raw.resetsAt), minutes, now);
  return window && { minutes, window };
}

const hasWindow = (snapshot: unknown): snapshot is Record<string, unknown> =>
  isRecord(snapshot) && (isRecord(snapshot.primary) || isRecord(snapshot.secondary));

/** The main snapshot, else the "codex" entry (or any entry) of the per-limit map. */
function pickSnapshot(result: Record<string, unknown>): Record<string, unknown> | undefined {
  if (hasWindow(result.rateLimits)) return result.rateLimits;
  const byId = isRecord(result.rateLimitsByLimitId) ? result.rateLimitsByLimitId : {};
  if (hasWindow(byId.codex)) return byId.codex;
  return Object.values(byId).find(hasWindow);
}

function creditFrom(raw: unknown): UsageResetCredit | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  if (!id) return undefined;
  const status = raw.status === 'available' || raw.status === 'redeeming' || raw.status === 'redeemed' ? raw.status : 'unknown';
  const expires = finite(raw.expiresAt);
  const credit: UsageResetCredit = { id, status };
  const title = text(raw.title);
  const description = text(raw.description);
  if (title) credit.title = title;
  if (description) credit.description = description;
  if (expires !== undefined) credit.expiresAt = new Date(expires * 1000).toISOString();
  return credit;
}

function resetCreditsFrom(raw: unknown): AgentUsage['resetCredits'] {
  if (!isRecord(raw) || !Array.isArray(raw.credits)) return undefined;
  const credits = raw.credits.map(creditFrom).filter((credit): credit is UsageResetCredit => credit !== undefined);
  return { availableCount: finite(raw.availableCount) ?? credits.filter((credit) => credit.status === 'available').length, credits };
}

/** Turn an `account/rateLimits/read` result into usage; undefined when it holds no known window. */
export function codexUsageFromRpc(result: unknown, now: number): AgentUsage | undefined {
  if (!isRecord(result)) return undefined;
  const snapshot = pickSnapshot(result);
  if (!snapshot) return undefined;
  const usage: AgentUsage = { source: 'live', live: true, updatedAt: new Date(now).toISOString() };
  for (const raw of [snapshot.primary, snapshot.secondary]) {
    const found = windowFrom(raw, now);
    if (found?.minutes === FIVE_HOUR_MINUTES) usage.fiveHour = found.window;
    else if (found?.minutes === WEEK_MINUTES) usage.weekly = found.window;
  }
  if (!usage.fiveHour && !usage.weekly) return undefined;
  const plan = text(snapshot.planType);
  if (plan) usage.plan = plan;
  const credits = resetCreditsFrom(result.rateLimitResetCredits);
  if (credits) usage.resetCredits = credits;
  return usage;
}

async function loadCodex(deps: LiveDeps): Promise<LiveResult> {
  const bin = (deps.resolveBin ?? resolveBin)('codex');
  const child = (deps.spawn ?? nodeSpawn)(bin.cmd, [...bin.prefixArgs, 'app-server'], { env: agentEnv(bin), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const kill = () => {
    try {
      child.kill();
    } catch {
      // already gone
    }
  };
  try {
    const result = await withTimeout(askAppServer(child), deps.timeoutMs ?? TIMEOUT_MS, kill);
    const usage = codexUsageFromRpc(result, (deps.now ?? Date.now)());
    return usage ? { ok: true, usage } : { ok: false, error: 'unavailable' };
  } catch (err) {
    return { ok: false, error: err instanceof RpcError && err.needsLogin ? 'needsLogin' : 'unavailable' };
  } finally {
    kill();
  }
}

/** Ask `codex app-server` for the account's rate limits. Never throws. */
export function fetchCodexLive(deps: LiveDeps = {}): Promise<LiveResult> {
  return cachedLive('codex', deps, () => loadCodex(deps));
}

/* ---- Claude: the OAuth usage endpoint ---- */

interface ClaudeCredentials { accessToken: string; expiresAt?: number; subscriptionType?: string }

function parseCredentials(raw: string): ClaudeCredentials | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    const oauth = isRecord(parsed) ? parsed.claudeAiOauth : undefined;
    const accessToken = isRecord(oauth) ? text(oauth.accessToken) : undefined;
    if (!isRecord(oauth) || !accessToken) return undefined;
    return { accessToken, expiresAt: finite(oauth.expiresAt), subscriptionType: text(oauth.subscriptionType) };
  } catch {
    return undefined;
  }
}

function claudeWindow(raw: unknown, minutes: number, now: number): UsageWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const resets = typeof raw.resets_at === 'string' ? Date.parse(raw.resets_at) : Number.NaN;
  // utilization is already a 0-100 percent here.
  return buildWindow(finite(raw.utilization), Number.isFinite(resets) ? resets / 1000 : undefined, minutes, now);
}

export function claudeUsageFromBody(body: unknown, plan: string | undefined, now: number): AgentUsage | undefined {
  if (!isRecord(body)) return undefined;
  const usage: AgentUsage = { source: 'live', live: true, updatedAt: new Date(now).toISOString() };
  const fiveHour = claudeWindow(body.five_hour, FIVE_HOUR_MINUTES, now);
  const weekly = claudeWindow(body.seven_day, WEEK_MINUTES, now);
  if (fiveHour) usage.fiveHour = fiveHour;
  if (weekly) usage.weekly = weekly;
  if (!fiveHour && !weekly) return undefined;
  if (plan) usage.plan = plan;
  return usage;
}

async function requestClaude(credentials: ClaudeCredentials, deps: LiveDeps): Promise<LiveResult> {
  const controller = new AbortController();
  const call = (deps.fetch ?? fetch)(CLAUDE_USAGE_URL, {
    headers: { Authorization: `Bearer ${credentials.accessToken}`, 'anthropic-beta': CLAUDE_BETA, Accept: 'application/json' },
    signal: controller.signal,
  });
  const response = await withTimeout(call, deps.timeoutMs ?? TIMEOUT_MS, () => controller.abort());
  if (response.status === 401 || response.status === 403) return { ok: false, error: 'needsLogin' };
  if (!response.ok) return { ok: false, error: 'unavailable' };
  const body: unknown = await withTimeout(response.json(), deps.timeoutMs ?? TIMEOUT_MS, () => controller.abort());
  const usage = claudeUsageFromBody(body, credentials.subscriptionType, (deps.now ?? Date.now)());
  return usage ? { ok: true, usage } : { ok: false, error: 'unavailable' };
}

async function loadClaude(deps: LiveDeps): Promise<LiveResult> {
  const dir = deps.claudeConfigDir ?? (process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'));
  let raw: string;
  try {
    raw = await (deps.readFile ?? ((file: string) => nodeReadFile(file, 'utf8')))(path.join(dir, '.credentials.json'));
  } catch {
    return { ok: false, error: 'unavailable' };
  }
  const credentials = parseCredentials(raw);
  if (!credentials) return { ok: false, error: 'unavailable' };
  // Never refresh the token: an expired one just means the user has to log in again.
  if (credentials.expiresAt !== undefined && credentials.expiresAt <= (deps.now ?? Date.now)()) return { ok: false, error: 'needsLogin' };
  try {
    return await requestClaude(credentials, deps);
  } catch {
    // Deliberately drop the error: it could carry request details.
    return { ok: false, error: 'unavailable' };
  }
}

/** Ask Anthropic for the logged-in account's usage windows. Never throws; the token stays in memory. */
export function fetchClaudeLive(deps: LiveDeps = {}): Promise<LiveResult> {
  return cachedLive('claude', deps, () => loadClaude(deps));
}

/* ---- Antigravity: `agy -p /usage --output-format json` ---- */

const AGY_USAGE_TIMEOUT_MS = 12_000;
const AGY_AUTH_FAILURE = /not (logged|signed) in|unauthenticated|unauthori[sz]ed|\b401\b|(login|sign[- ]?in) (is )?required|please (log|sign) ?in|(credentials|token) (have |has )?expired/i;

function parseAgyJson(text: string): Record<string, unknown> | undefined {
  try {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) return parsed;
    }
  } catch {
    // try finding by line
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRecord(parsed)) return parsed;
      } catch {
        // ignore
      }
    }
  }
  return undefined;
}

export function antigravityUsageFromOutput(output: string, now: number): AgentUsage | undefined {
  const usage: AgentUsage = { source: 'live', live: true, updatedAt: new Date(now).toISOString() };
  const parsed = parseAgyJson(output);

  // 1. Prefer command.data.groups from --output-format json
  if (parsed) {
    const cmd = isRecord(parsed.command) ? parsed.command : undefined;
    const data = isRecord(cmd?.data) ? cmd.data : undefined;
    const groups = Array.isArray(data?.groups) ? data.groups : undefined;
    if (groups && groups.length > 0) {
      const gemini = groups.find((g) => isRecord(g) && typeof g.name === 'string' && /gemini/i.test(g.name));
      const chosen = gemini ?? groups.find((g) => isRecord(g) && Array.isArray(g.buckets) && g.buckets.length > 0);
      if (isRecord(chosen) && Array.isArray(chosen.buckets)) {
        for (const bucket of chosen.buckets) {
          if (!isRecord(bucket)) continue;
          const rem = finite(bucket.remaining_fraction);
          if (rem === undefined) continue;
          const usedPercent = Math.max(0, Math.min(100, (1 - rem) * 100));
          const resetIso = text(bucket.reset_time);
          const resetsAtSeconds = resetIso ? Math.round(Date.parse(resetIso) / 1000) : undefined;
          const window = text(bucket.window);
          const id = text(bucket.id);
          const name = text(bucket.name);
          const is5h = window === '5h' || id?.includes('5h') || (name ? /(5|five)[- ]?hour/i.test(name) : false);
          const isWeekly = window === 'weekly' || id?.includes('weekly') || (name ? /week/i.test(name) : false);
          if (is5h) {
            usage.fiveHour = buildWindow(usedPercent, resetsAtSeconds, FIVE_HOUR_MINUTES, now);
          } else if (isWeekly) {
            usage.weekly = buildWindow(usedPercent, resetsAtSeconds, WEEK_MINUTES, now);
          }
        }
      }
    }
    if (usage.fiveHour || usage.weekly) return usage;
  }

  // 2. Fallback: Parse TSV lines (from parsed.response or raw output)
  const textContent = (parsed && typeof parsed.response === 'string' ? parsed.response : output);
  const lines = textContent.split(/\r?\n/);
  for (const line of lines) {
    const parts = line.split(/\t|\\t/);
    if (parts.length >= 3) {
      const groupName = parts[0]?.trim() ?? '';
      const bucketName = parts[1]?.trim() ?? '';
      const percentMatch = /(\d+(?:\.\d+)?)%/.exec(parts[2] ?? '');
      const resetIso = parts[3]?.trim();
      if (percentMatch) {
        const remainingPercent = parseFloat(percentMatch[1]);
        const usedPercent = Math.max(0, Math.min(100, 100 - remainingPercent));
        const resetsAtSeconds = resetIso && !Number.isNaN(Date.parse(resetIso)) ? Math.round(Date.parse(resetIso) / 1000) : undefined;
        const isGemini = /gemini/i.test(groupName);
        if (/(5|five)[- ]?hour|5h/i.test(bucketName) && (!usage.fiveHour || isGemini)) {
          usage.fiveHour = buildWindow(usedPercent, resetsAtSeconds, FIVE_HOUR_MINUTES, now);
        } else if (/week/i.test(bucketName) && (!usage.weekly || isGemini)) {
          usage.weekly = buildWindow(usedPercent, resetsAtSeconds, WEEK_MINUTES, now);
        }
      }
    }
  }

  if (usage.fiveHour || usage.weekly) return usage;
  return undefined;
}

async function loadAntigravity(deps: LiveDeps): Promise<LiveResult> {
  let bin: ResolvedBin;
  try {
    bin = (deps.resolveBin ?? resolveBin)('antigravity');
    if (bin.source === 'none') return { ok: false, error: 'unavailable' };
  } catch {
    return { ok: false, error: 'unavailable' };
  }

  const child = (deps.spawn ?? nodeSpawn)(bin.cmd, [...bin.prefixArgs, '-p', '/usage', '--output-format', 'json'], {
    env: agentEnv(bin),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const kill = () => {
    try {
      child.kill();
    } catch {
      // already gone
    }
  };

  try {
    const { stdout, stderr, code } = await withTimeout(
      new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        child.on('error', (err) => reject(err));
        child.on('close', (code) => resolve({ stdout, stderr, code }));
      }),
      deps.timeoutMs ?? AGY_USAGE_TIMEOUT_MS,
      kill,
    );

    const combined = `${stdout}\n${stderr}`;
    if (code !== 0 && AGY_AUTH_FAILURE.test(combined)) {
      return { ok: false, error: 'needsLogin' };
    }

    const usage = antigravityUsageFromOutput(stdout, (deps.now ?? Date.now)());
    if (usage) return { ok: true, usage };

    if (AGY_AUTH_FAILURE.test(combined)) {
      return { ok: false, error: 'needsLogin' };
    }
    return { ok: false, error: 'unavailable' };
  } catch {
    return { ok: false, error: 'unavailable' };
  } finally {
    kill();
  }
}

/** Ask `agy -p /usage --output-format json` for Antigravity's quota windows. Never throws. */
export function fetchAntigravityLive(deps: LiveDeps = {}): Promise<LiveResult> {
  return cachedLive('antigravity', deps, () => loadAntigravity(deps));
}

