import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ResolvedBin } from './bins.ts';
import type { AgentName } from './types.ts';

/**
 * Plan-only guard: agents may only spend the Claude / ChatGPT subscription quota, never
 * pay-as-you-go API billing, Claude extra usage or Codex credits.
 */

// Variables that switch a CLI from the subscription login to metered billing.
const METERED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_API_KEY',
];

/** Environment for every agent CLI we start: inherited, minus anything that bills per token. */
export function agentEnv(bin: ResolvedBin): NodeJS.ProcessEnv {
  const env = { ...process.env, ...bin.env };
  for (const key of METERED_ENV) delete env[key];
  return env;
}

export class PlanOnlyError extends Error {}

/** Output of a status command; a non-zero exit still returns what the CLI printed. */
function run(bin: ResolvedBin, args: string[], cwd: string): Promise<{ out: string; error?: string }> {
  return new Promise((resolve) =>
    execFile(bin.cmd, [...bin.prefixArgs, ...args], { cwd, env: agentEnv(bin), timeout: 20_000, windowsHide: true }, (err, out, errOut) =>
      resolve({ out: `${out}\n${errOut}`.trim(), ...(err && { error: err.message }) }),
    ),
  );
}

/**
 * ok: logged in with the subscription. failed: confirmed not logged in, or logged in a way that
 * bills per token. unknown: the CLI could not report its login (e.g. a version without the status command).
 */
export type AuthStatus = { state: 'ok' } | { state: 'failed' | 'unknown'; error: string };

// Claude reports extra usage on its rate-limit events; once seen, Claude stays blocked until the
// window that ran out resets.
let claudeBlockedUntil = 0;

export function blockClaudeUntil(resetsAtSec: number | undefined) {
  // Without a reset time, hold for five hours (the shortest Claude window).
  claudeBlockedUntil = Math.max(claudeBlockedUntil, resetsAtSec ? resetsAtSec * 1000 : Date.now() + 5 * 3600_000);
}

const resetText = (ms: number) => new Date(ms).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

// Login checks are cached per agent and working directory (project settings can change auth).
const authCache = new Map<string, { at: number }>();
const AUTH_TTL = 5 * 60_000;
const NOT_LOGGED_IN = /not logged in|logged out|please (log|sign) ?in|login required/i;

/** `claude auth status` prints JSON; it never calls a model. */
export async function claudeAuthStatus(bin: ResolvedBin, cwd: string): Promise<AuthStatus> {
  const { out, error } = await run(bin, ['auth', 'status'], cwd);
  const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
  let status: { loggedIn?: boolean; authMethod?: string; apiProvider?: string; subscriptionType?: string };
  try {
    status = JSON.parse(json);
  } catch {
    if (NOT_LOGGED_IN.test(out)) return { state: 'failed', error: 'Claude CLI chưa đăng nhập. Chạy `claude` rồi đăng nhập bằng tài khoản claude.ai (gói Pro/Max).' };
    return { state: 'unknown', error: `Không đọc được trạng thái đăng nhập Claude (claude auth status): ${(out || error || '').slice(0, 300)}` };
  }
  if (!status.loggedIn) return { state: 'failed', error: 'Claude CLI chưa đăng nhập. Chạy `claude` rồi đăng nhập bằng tài khoản claude.ai (gói Pro/Max).' };
  if (status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty')
    return { state: 'failed', error: `Claude đang đăng nhập bằng "${status.authMethod}" / "${status.apiProvider}", sẽ bị tính tiền theo API. Đăng nhập lại bằng tài khoản claude.ai (gói Pro/Max).` };
  return { state: 'ok' };
}

/** `codex login status` prints one line describing the login; it never calls a model. */
export async function codexAuthStatus(bin: ResolvedBin, cwd: string): Promise<AuthStatus> {
  const { out, error } = await run(bin, ['login', 'status'], cwd);
  if (/logged in using chatgpt/i.test(out)) return { state: 'ok' };
  if (/api key/i.test(out)) return { state: 'failed', error: 'Codex đang đăng nhập bằng API key, sẽ bị tính tiền theo token. Chạy `codex logout` rồi `codex login` bằng tài khoản ChatGPT.' };
  if (NOT_LOGGED_IN.test(out)) return { state: 'failed', error: 'Codex CLI chưa đăng nhập. Chạy `codex login` bằng tài khoản ChatGPT.' };
  return { state: 'unknown', error: `Không xác minh được Codex đã đăng nhập bằng ChatGPT (codex login status: ${(out || error || '').slice(0, 200)}).` };
}

/** Login status; only a good login is cached, so a fixed login or upgraded CLI is seen at once. */
export async function authStatus(agent: AgentName, bin: ResolvedBin, cwd: string): Promise<AuthStatus> {
  const key = `${agent}|${cwd}`;
  const cached = authCache.get(key);
  if (cached && Date.now() - cached.at <= AUTH_TTL) return { state: 'ok' };
  const status = agent === 'claude' ? await claudeAuthStatus(bin, cwd) : await codexAuthStatus(bin, cwd);
  if (status.state === 'ok') authCache.set(key, { at: Date.now() });
  else authCache.delete(key);
  return status;
}

interface CodexLimits {
  primary?: { used_percent?: number };
  secondary?: { used_percent?: number };
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string };
}

/** Newest rate-limit snapshot Codex wrote to its session logs (exec --json does not stream it). */
async function latestCodexLimits(): Promise<CodexLimits | null> {
  const root = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions');
  // sessions/YYYY/MM/DD/rollout-*.jsonl: walk the newest day folders first.
  const newest = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort().reverse();
  for (const y of (await newest(root)).slice(0, 2))
    for (const m of (await newest(path.join(root, y))).slice(0, 2))
      for (const d of (await newest(path.join(root, y, m))).slice(0, 3)) {
        const dir = path.join(root, y, m, d);
        const files = await Promise.all(
          (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.jsonl')).map(async (f) => ({ f, t: (await stat(path.join(dir, f))).mtimeMs })),
        );
        for (const { f } of files.sort((a, b) => b.t - a.t)) {
          const lines = (await readFile(path.join(dir, f), 'utf8').catch(() => '')).split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].includes('"rate_limits"')) continue;
            try {
              const limits = JSON.parse(lines[i])?.payload?.rate_limits;
              if (limits) return limits;
            } catch {}
          }
        }
      }
  return null;
}

/**
 * Throws PlanOnlyError when this agent could spend anything outside the subscription quota.
 * `allowUnverifiedAuth` lets a CLI that cannot report its login run anyway (the user opted in with
 * --skip-auth-check); a confirmed wrong or missing login still stops.
 */
export async function assertPlanOnly(agent: AgentName, bin: ResolvedBin, cwd: string, { allowUnverifiedAuth = false } = {}) {
  if (agent === 'claude' && Date.now() < claudeBlockedUntil)
    throw new PlanOnlyError(`Claude đã hết hạn mức gói và bắt đầu dùng extra usage (tính tiền). AI Duo tạm chặn Claude tới ${resetText(claudeBlockedUntil)}.`);

  const auth = await authStatus(agent, bin, cwd);
  if (auth.state === 'failed' || (auth.state === 'unknown' && !allowUnverifiedAuth)) throw new PlanOnlyError(auth.error);

  if (agent === 'codex') {
    // With the plan window used up, further Codex turns would draw on purchased credits.
    const limits = await latestCodexLimits();
    const exhausted = [limits?.primary?.used_percent, limits?.secondary?.used_percent].some((p) => (p ?? 0) >= 100);
    const credits = limits?.credits;
    if (exhausted && (credits?.has_credits || credits?.unlimited || Number(credits?.balance) > 0))
      throw new PlanOnlyError('Codex đã dùng hết hạn mức của gói ChatGPT; chạy tiếp sẽ trừ vào credits. AI Duo dừng lại, hãy đợi hạn mức reset.');
  }
}

export function claudeOverageMessage(resetsAtSec?: number) {
  return `Claude đã hết hạn mức gói và chuyển sang extra usage (tính tiền). AI Duo đã dừng lượt này${resetsAtSec ? ` và chặn Claude tới ${resetText(resetsAtSec * 1000)}` : ''}.`;
}
