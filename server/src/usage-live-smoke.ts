import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ResolvedBin } from './agents/bins.ts';
import { getConnection, openLogin, parseClaudeStatus, parseCodexStatus } from './connection.ts';
import { usageRoutes } from './routes/usage.ts';
import type { RunService } from './service.ts';
import { getUsage } from './usage.ts';
import { clearLiveCache, fetchClaudeLive, fetchCodexLive, type LiveDeps } from './usage-live.ts';

const root = await mkdtemp(path.join(tmpdir(), 'ai-duo-usage-live-'));
process.env.CODEX_HOME = path.join(root, 'no-codex-home');
const TOKEN = 'sk-ant-oat01-SECRET-TOKEN-VALUE';
const NOW = Date.parse('2026-09-30T12:00:00Z');
const nowSec = NOW / 1000;

const fakeBin = (script: string, env: Record<string, string> = {}): ResolvedBin => ({
  cmd: process.execPath,
  prefixArgs: [script],
  resolvedFrom: script,
  source: 'env',
  env,
});

// Fake `codex app-server`: JSON-RPC lines in, JSON-RPC lines out, with junk in between.
const appServer = path.join(root, 'app-server.mjs');
await writeFile(appServer, String.raw`
import readline from 'node:readline';
const mode = process.env.MODE;
const window = (used, mins, resetsAt) => ({ usedPercent: used, windowDurationMins: mins, resetsAt });
const snapshot = { limitId: 'codex', planType: 'plus', primary: window(24, 300, ${nowSec + 3600}), secondary: window(58, 10080, ${nowSec + 86400}) };
const out = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write('warning: not json\n');
    out({ id: message.id, result: { userAgent: 'fake' } });
  } else if (message.method === 'account/rateLimits/read') {
    process.stdout.write('{"broken":\n');
    if (mode === 'hang') return;
    if (mode === 'error') return out({ id: message.id, error: { code: -1, message: 'Not logged in, please sign in' } });
    if (mode === 'fallback') {
      out({ id: message.id, result: { rateLimits: { limitId: 'other', primary: null, secondary: null }, rateLimitsByLimitId: { other: { primary: null, secondary: null }, codex: snapshot } } });
      return;
    }
    out({ id: message.id, result: {
      rateLimits: snapshot,
      rateLimitResetCredits: { availableCount: 1, credits: [
        { id: 'c1', title: 'Bank reset', description: 'Wipes windows', grantedAt: 1, expiresAt: ${nowSec + 500}, status: 'available', resetType: 'both' },
        { id: 'c2', grantedAt: 2, expiresAt: null, status: 'weird', resetType: 'both' },
      ] },
    } });
  }
});
`);

const codexDeps = (mode: string, extra: LiveDeps = {}): LiveDeps => ({ now: () => NOW, resolveBin: () => fakeBin(appServer, { MODE: mode }), timeoutMs: 4000, ...extra });

try {
  // ---- Codex live ----
  const ok = await fetchCodexLive(codexDeps('basic'));
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.usage.live, true);
    assert.equal(ok.usage.source, 'live');
    assert.equal(ok.usage.plan, 'plus');
    assert.equal(ok.usage.updatedAt, new Date(NOW).toISOString());
    assert.equal(ok.usage.fiveHour?.usedPercent, 24);
    assert.equal(ok.usage.fiveHour?.windowMinutes, 300);
    assert.equal(ok.usage.fiveHour?.resetsAt, new Date((nowSec + 3600) * 1000).toISOString());
    assert.equal(ok.usage.weekly?.usedPercent, 58);
    assert.equal(ok.usage.weekly?.windowMinutes, 10080);
    assert.equal(ok.usage.resetCredits?.availableCount, 1);
    assert.equal(ok.usage.resetCredits?.credits.length, 2);
    assert.deepEqual(ok.usage.resetCredits?.credits[0], { id: 'c1', title: 'Bank reset', description: 'Wipes windows', expiresAt: new Date((nowSec + 500) * 1000).toISOString(), status: 'available' });
    assert.deepEqual(ok.usage.resetCredits?.credits[1], { id: 'c2', status: 'unknown' });
  }

  clearLiveCache();
  const fallback = await fetchCodexLive(codexDeps('fallback'));
  assert.ok(fallback.ok && fallback.usage.fiveHour?.usedPercent === 24 && fallback.usage.weekly?.usedPercent === 58, 'null primary falls back to the codex limit id');

  clearLiveCache();
  assert.deepEqual(await fetchCodexLive(codexDeps('error')), { ok: false, error: 'needsLogin' });

  clearLiveCache();
  const started = Date.now();
  assert.deepEqual(await fetchCodexLive(codexDeps('hang', { timeoutMs: 400 })), { ok: false, error: 'unavailable' });
  assert.ok(Date.now() - started < 3000, 'a silent app-server is cut off by the timeout');

  clearLiveCache();
  const missing: LiveDeps = { now: () => NOW, resolveBin: () => fakeBin(path.join(root, 'nope.mjs')), timeoutMs: 2000 };
  assert.deepEqual(await fetchCodexLive(missing), { ok: false, error: 'unavailable' }, 'a process that exits early is unavailable');
  clearLiveCache();
  assert.deepEqual(await fetchCodexLive({ ...missing, resolveBin: () => ({ ...fakeBin('x'), cmd: path.join(root, 'no-such-binary') }) }), { ok: false, error: 'unavailable' });

  // ---- Claude live ----
  const creds = (extra: Record<string, unknown> = {}) => JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW + 3_600_000, subscriptionType: 'max', ...extra } });
  const body = { five_hour: { utilization: 24.0, resets_at: '2026-09-30T15:59:59.597780+00:00' }, seven_day: { utilization: 58.0, resets_at: '2026-10-05T00:00:00+00:00' }, other: null };
  const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  let calls = 0;
  let seen: { url: string; headers: Record<string, string> } | undefined;
  const fakeFetch = (status = 200, payload: unknown = body): typeof fetch => async (input, init) => {
    calls++;
    seen = { url: String(input), headers: init?.headers as Record<string, string> };
    return json(status, payload);
  };
  const claudeDeps = (over: LiveDeps = {}): LiveDeps => ({ now: () => NOW, readFile: async () => creds(), fetch: fakeFetch(), timeoutMs: 1000, ...over });

  clearLiveCache();
  const claude = await fetchClaudeLive(claudeDeps());
  assert.ok(claude.ok);
  if (claude.ok) {
    assert.equal(claude.usage.fiveHour?.usedPercent, 24, 'utilization is already a percent');
    assert.equal(claude.usage.fiveHour?.resetsAt, '2026-09-30T15:59:59.597Z');
    assert.equal(claude.usage.weekly?.usedPercent, 58);
    assert.equal(claude.usage.plan, 'max');
    assert.equal(claude.usage.live, true);
    assert.equal(claude.usage.updatedAt, new Date(NOW).toISOString());
  }
  assert.equal(seen?.url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(seen?.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(seen?.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.ok(!JSON.stringify(claude).includes(TOKEN), 'token never appears in the result');

  const failures: [string, LiveDeps, string][] = [
    ['401', claudeDeps({ fetch: fakeFetch(401, { error: TOKEN }) }), 'needsLogin'],
    ['403', claudeDeps({ fetch: fakeFetch(403, {}) }), 'needsLogin'],
    ['expired', claudeDeps({ readFile: async () => creds({ expiresAt: NOW - 1 }) }), 'needsLogin'],
    ['500', claudeDeps({ fetch: fakeFetch(500, {}) }), 'unavailable'],
    ['no windows', claudeDeps({ fetch: fakeFetch(200, { unexpected: true }) }), 'unavailable'],
    ['missing file', claudeDeps({ readFile: async () => Promise.reject(new Error(`ENOENT ${TOKEN}`)) }), 'unavailable'],
    ['bad json', claudeDeps({ readFile: async () => '{not json' }), 'unavailable'],
    ['no token', claudeDeps({ readFile: async () => JSON.stringify({ claudeAiOauth: {} }) }), 'unavailable'],
    ['network error', claudeDeps({ fetch: async () => Promise.reject(new Error(`boom ${TOKEN}`)) }), 'unavailable'],
    ['timeout', claudeDeps({ timeoutMs: 200, fetch: () => new Promise<Response>(() => undefined) }), 'unavailable'],
  ];
  for (const [label, deps, error] of failures) {
    clearLiveCache();
    const result = await fetchClaudeLive(deps);
    assert.deepEqual(result, { ok: false, error }, label);
    assert.ok(!JSON.stringify(result).includes(TOKEN), `${label}: no token in result`);
  }

  // ---- Cache, coalescing, force ----
  clearLiveCache();
  calls = 0;
  let clock = NOW;
  const cacheDeps = (force = false): LiveDeps => claudeDeps({ now: () => clock, force });
  await Promise.all([fetchClaudeLive(cacheDeps()), fetchClaudeLive(cacheDeps()), fetchClaudeLive(cacheDeps())]);
  assert.equal(calls, 1, 'concurrent requests share one fetch');
  await fetchClaudeLive(cacheDeps());
  assert.equal(calls, 1, 'cached inside 30s');
  await fetchClaudeLive(cacheDeps(true));
  assert.equal(calls, 2, 'force bypasses the cache');
  clock += 31_000;
  await fetchClaudeLive(cacheDeps());
  assert.equal(calls, 3, 'cache expires after 30s');

  // ---- getUsage: live preferred, fallback flagged ----
  clearLiveCache();
  const liveUsage = await getUsage(undefined, NOW, { deps: { ...claudeDeps(), ...codexDeps('basic') } });
  assert.equal(liveUsage.claude.live, true);
  assert.equal(liveUsage.claude.source, 'live');
  assert.equal(liveUsage.codex.live, true);
  assert.equal(liveUsage.codex.plan, 'plus');
  assert.equal(liveUsage.codex.resetCredits?.availableCount, 1);

  clearLiveCache();
  const runs = [{ id: 'r', mode: 'code' as const, agent: 'claude' as const, prompt: '', cwd: '', status: 'done' as const, createdAt: 1000, claudeLimits: { seven_day: { utilization: 0.5, resetsAt: nowSec + 60 } } }];
  const down = await getUsage(runs, NOW, { deps: { ...claudeDeps({ fetch: fakeFetch(401, {}) }), ...codexDeps('hang', { timeoutMs: 300 }) } });
  assert.equal(down.claude.live, false);
  assert.equal(down.claude.error, 'needsLogin');
  assert.equal(down.claude.source, 'run-history');
  assert.equal(down.claude.weekly?.usedPercent, 50, 'run history stays as the fallback');
  assert.equal(down.codex.live, false);
  assert.equal(down.codex.error, 'unavailable', 'nothing else to show, so unavailable is reported');

  clearLiveCache();
  const quiet = await getUsage(runs, NOW, { deps: { ...claudeDeps({ readFile: async () => Promise.reject(new Error('x')) }), ...codexDeps('hang', { timeoutMs: 300 }) } });
  assert.equal(quiet.claude.error, undefined, 'missing credentials with fallback data is not an error');
  assert.equal(quiet.claude.live, false);

  // ---- Connection with fake CLIs ----
  const cli = path.join(root, 'cli.mjs');
  await writeFile(cli, String.raw`
const args = process.argv.slice(2);
const mode = process.env.MODE;
if (args.includes('--version')) console.log('9.9.9');
else if (args[0] === 'auth') console.log(mode === 'in' ? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', secret: 'x' }) : JSON.stringify({ loggedIn: false }));
else if (args[0] === 'login') { console.error(mode === 'in' ? 'Logged in using ChatGPT' : 'Not logged in'); process.exit(mode === 'in' ? 0 : 1); }
`);
  const connect = (agent: 'claude' | 'codex', mode: string) => getConnection(agent, { resolveBin: () => fakeBin(cli, { MODE: mode }) });
  assert.deepEqual(await connect('claude', 'in'), { agent: 'claude', installed: true, version: '9.9.9', path: cli, loggedIn: true, method: 'claude.ai', account: 'a@b.c', error: null });
  assert.equal((await connect('claude', 'out')).loggedIn, false);
  const codexIn = await connect('codex', 'in');
  assert.deepEqual([codexIn.loggedIn, codexIn.method, codexIn.account], [true, 'ChatGPT', null]);
  assert.equal((await connect('codex', 'out')).loggedIn, false);
  const gone = await getConnection('codex', { resolveBin: () => ({ ...fakeBin('x'), source: 'none' }) });
  assert.deepEqual([gone.installed, gone.version, gone.path, gone.loggedIn], [false, null, null, null]);
  assert.ok(gone.error);
  const broken = await getConnection('codex', { resolveBin: () => { throw new Error(`shim ${TOKEN}`); } });
  assert.equal(broken.installed, false);
  assert.ok(!JSON.stringify(broken).includes(TOKEN));
  assert.equal((await getConnection('claude', { resolveBin: () => fakeBin(cli), version: async () => ({ version: null }) })).error, 'CLI could not be run');
  assert.equal(parseClaudeStatus('garbage').loggedIn, null);
  assert.equal(parseClaudeStatus('Not logged in').loggedIn, false);
  assert.equal(parseCodexStatus('nothing useful').loggedIn, null);

  // ---- Login + routes with a fake terminal launcher ----
  const launched: string[][] = [];
  const hooks = (launchResult = true, bin = fakeBin(cli)) => ({
    usage: { live: false },
    connection: { resolveBin: () => ({ ...bin, cmd: path.join(root, 'claude-abs.exe'), prefixArgs: [] }), launch: async (command: string[]) => { launched.push(command); return launchResult; } },
  });
  const app = usageRoutes({ list: async () => [] } as unknown as RunService, hooks());
  const post = (name: string, init?: RequestInit) => app.request(`/api/agents/${name}/login`, { method: 'POST', ...init });

  assert.equal((await post('bash')).status, 400);
  assert.equal((await app.request('/api/agents/bash/connection')).status, 400);
  assert.equal(launched.length, 0);
  const res = await post('claude', { method: 'POST', body: JSON.stringify({ command: 'calc.exe', cmd: 'evil' }), headers: { 'content-type': 'application/json' } });
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.deepEqual(launched.at(-1), [path.join(root, 'claude-abs.exe'), 'auth', 'login'], 'request body cannot change the command');
  assert.equal((await post('codex')).status, 200);
  assert.deepEqual(launched.at(-1)?.slice(1), ['login']);

  const failing = usageRoutes({ list: async () => [] } as unknown as RunService, hooks(false));
  const failed = await failing.request('/api/agents/claude/login', { method: 'POST' });
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'Could not open a terminal' });
  assert.equal(await openLogin('claude', { resolveBin: () => ({ ...fakeBin('x'), source: 'none' }), launch: async () => true }), 'notInstalled');
  assert.equal(await openLogin('claude', { resolveBin: () => ({ ...fakeBin('x'), cmd: 'claude' }), launch: async () => true }), 'notInstalled', 'relative command is refused');

  const status = await app.request('/api/agents/claude/connection');
  assert.equal(status.status, 200);
  assert.equal(((await status.json()) as { agent: string }).agent, 'claude');
  const usageRes = await app.request('/api/usage?refresh=1');
  assert.equal(usageRes.status, 200);

  console.log('usage live smoke ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
