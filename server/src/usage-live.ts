import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { readFile as nodeReadFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { agentEnv } from './agents/billing.ts';
import { resolveBin, type ResolvedBin } from './agents/bins.ts';
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
  spawn?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'ignore']; windowsHide: boolean }) => ChildProcess;
  resolveBin?: (name: 'codex') => ResolvedBin;
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
