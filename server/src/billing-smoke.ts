import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentEnv, assertPlanOnly, blockClaudeUntil, PlanOnlyError } from './agents/billing.ts';
import { resolveBin } from './agents/bins.ts';
import { initialClaudeJsonState, onJson } from './agents/claude.ts';

// Metered-billing variables never reach an agent CLI.
process.env.ANTHROPIC_API_KEY = 'sk-test';
process.env.OPENAI_API_KEY = 'sk-test';
const env = agentEnv({ cmd: 'x', prefixArgs: [], resolvedFrom: 'x', env: { ELECTRON_RUN_AS_NODE: '1' } });
assert.equal(env.ANTHROPIC_API_KEY, undefined);
assert.equal(env.OPENAI_API_KEY, undefined);
assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
assert.ok(env.PATH || env.Path, 'the rest of the environment is kept');
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

// Extra usage on a rate-limit event marks the turn to stop.
const within = onJson({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: false } }, initialClaudeJsonState());
assert.equal(within.state.overage, undefined);
const over = onJson({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: true, resetsAt: 1_900_000_000 } }, initialClaudeJsonState());
assert.deepEqual(over.state.overage, { resetsAt: 1_900_000_000 });
assert.match(over.state.errorText ?? '', /extra usage/);

// The logins on this machine are subscription logins.
const cwd = process.cwd();
await assertPlanOnly('claude', resolveBin('claude'), cwd);
await assertPlanOnly('codex', resolveBin('codex'), cwd); // also caches the real login before CODEX_HOME is faked

// Codex: an exhausted plan window with credits on the account is refused.
const home = await mkdtemp(path.join(tmpdir(), 'ai-duo-codex-home-'));
try {
  const day = path.join(home, 'sessions', '2099', '01', '01');
  await mkdir(day, { recursive: true });
  const limits = (used: number, credits: boolean) =>
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: used }, secondary: { used_percent: 10 }, credits: { has_credits: credits, unlimited: false, balance: credits ? '25' : '0' } } } });
  process.env.CODEX_HOME = home;

  await writeFile(path.join(day, 'rollout-a.jsonl'), limits(60, true) + '\n');
  await assertPlanOnly('codex', resolveBin('codex'), cwd);

  await writeFile(path.join(day, 'rollout-a.jsonl'), limits(100, false) + '\n');
  await assertPlanOnly('codex', resolveBin('codex'), cwd); // nothing to charge: the CLI just stops at the limit

  await writeFile(path.join(day, 'rollout-a.jsonl'), limits(100, true) + '\n');
  await assert.rejects(assertPlanOnly('codex', resolveBin('codex'), cwd), PlanOnlyError);
} finally {
  delete process.env.CODEX_HOME;
  await rm(home, { recursive: true, force: true });
}

// After extra usage Claude stays blocked until the window resets.
blockClaudeUntil(Math.floor(Date.now() / 1000) + 3600);
await assert.rejects(assertPlanOnly('claude', resolveBin('claude'), cwd), PlanOnlyError);

console.log('PASS metered env stripped, subscription logins, Claude extra-usage stop and block, Codex credits guard');
