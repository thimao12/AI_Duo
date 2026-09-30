import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunSummary } from './store.ts';
import { getUsage } from './usage.ts';

const now = Date.parse('2026-06-01T12:00:00Z');
const nowSec = now / 1000;
const root = await mkdtemp(path.join(tmpdir(), 'ai-duo-usage-'));
process.env.CODEX_HOME = root;

const tokenCount = (primary: number, secondary: number, resetsAt: number) => JSON.stringify({
  timestamp: '2026-06-01T11:00:00.000Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    rate_limits: {
      primary: { used_percent: primary, window_minutes: 300, resets_at: resetsAt },
      secondary: { used_percent: secondary, window_minutes: 10080, resets_at: resetsAt + 86400 },
    },
  },
});

try {
  // Missing sessions folder: everything undefined, no throw.
  const empty = await getUsage(undefined, now);
  assert.equal(empty.codex.fiveHour, undefined);
  assert.equal(empty.claude.fiveHour, undefined);

  const day = path.join(root, 'sessions', '2026', '06', '01');
  await mkdir(day, { recursive: true });
  const older = path.join(root, 'sessions', '2026', '05', '31');
  await mkdir(older, { recursive: true });
  await writeFile(path.join(older, 'rollout-2026-05-31T10-00-00-a.jsonl'), tokenCount(99, 99, nowSec + 100) + '\n');
  await writeFile(path.join(day, 'rollout-2026-06-01T10-00-00-b.jsonl'), [
    '{"type":"session_meta"}',
    tokenCount(10, 20, nowSec + 3600),
    'not json "rate_limits"',
    tokenCount(42.25, 7, nowSec + 7200),
    '{"payload":{"type":"token_count","rate_limits":',
    '',
  ].join('\n'));

  const usage = await getUsage(undefined, now);
  assert.equal(usage.codex.fiveHour?.usedPercent, 42.3, 'last token_count wins, rounded to 0.1');
  assert.equal(usage.codex.fiveHour?.windowMinutes, 300);
  assert.equal(usage.codex.fiveHour?.resetsAt, new Date((nowSec + 7200) * 1000).toISOString());
  assert.equal(usage.codex.fiveHour?.stale, undefined);
  assert.equal(usage.codex.weekly?.usedPercent, 7);
  assert.equal(usage.codex.weekly?.windowMinutes, 10080);
  assert.equal(usage.codex.updatedAt, '2026-06-01T11:00:00.000Z');

  // Stale: reset time already passed.
  await writeFile(path.join(day, 'rollout-2026-06-01T11-00-00-c.jsonl'), tokenCount(80, 30, nowSec - 60) + '\n');
  const stale = await getUsage(undefined, now);
  assert.equal(stale.codex.fiveHour?.stale, true);
  assert.equal(stale.codex.fiveHour?.usedPercent, 80);

  // Only the tail of a big file is read; an early cut line is tolerated.
  await writeFile(path.join(day, 'rollout-2026-06-01T12-00-00-d.jsonl'), tokenCount(1, 1, nowSec + 10) + '\n' + 'x'.repeat(400 * 1024) + '\n' + tokenCount(55, 5, nowSec + 500) + '\n');
  assert.equal((await getUsage(undefined, now)).codex.fiveHour?.usedPercent, 55);

  // A newest snapshot without windows (limit_id "premium") is skipped for the earlier good one.
  const premium = JSON.stringify({ timestamp: '2026-06-01T11:30:00.000Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'premium', primary: null, secondary: null } } });
  await writeFile(path.join(day, 'rollout-2026-06-01T13-00-00-e.jsonl'), [tokenCount(61, 9, nowSec + 900), premium, ''].join('\n'));
  const skippedNull = await getUsage(undefined, now);
  assert.equal(skippedNull.codex.fiveHour?.usedPercent, 61);
  assert.equal(skippedNull.codex.weekly?.usedPercent, 9);

  // Claude: newest run with limits; utilization is a fraction.
  const run = (id: string, createdAt: number, claudeLimits?: RunSummary['claudeLimits']): RunSummary => ({ id, mode: 'code', agent: 'claude', prompt: '', cwd: '', status: 'done', createdAt, claudeLimits });
  const claude = (await getUsage([
    run('a', 1000, { five_hour: { utilization: 0.9, resetsAt: nowSec + 60 } }),
    run('b', 3000, { five_hour: { utilization: 0.25, resetsAt: nowSec + 600 }, seven_day: { utilization: 0.5, resetsAt: nowSec - 5 } }),
    run('c', 5000),
  ], now)).claude;
  assert.equal(claude.fiveHour?.usedPercent, 25);
  assert.equal(claude.weekly?.usedPercent, 50);
  assert.equal(claude.weekly?.stale, true);
  assert.equal(claude.fiveHour?.stale, undefined);
  assert.equal(claude.updatedAt, new Date(3000).toISOString());
  console.log('usage smoke ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
