/**
 * Smoke test for RunService with fake agents: validation, preflight, streaming, Plan approval,
 * the review limit, follow-ups, cancellation, and the repository lock across paths and processes.
 *   pnpm --filter server test:service
 *
 * Also runs as a helper child process: `service-smoke.ts --hold <dir> <runId> [--crash]` takes the
 * repository lock and reports ACQUIRED or LOCKED on stdout.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentCheck, AgentName, RunOptions, RunResult } from './agents/types.ts';
import type { RunEvent } from './types.ts';

const [, , flag, holdDir, holdRunId, crash] = process.argv;

if (flag === '--hold') {
  const { acquireRepoLock, lockTarget, RepoLockedError } = await import('./lock.ts');
  try {
    const lock = await acquireRepoLock(await lockTarget(holdDir), holdRunId, 'smoke');
    console.log('ACQUIRED');
    if (crash === '--crash') process.exit(0); // dies without releasing
    // Release when the parent says so (a line on stdin) or goes away.
    createInterface({ input: process.stdin }).once('line', () => void lock.release().then(() => process.exit(0))).once('close', () => void lock.release().then(() => process.exit(0)));
  } catch (err) {
    console.log(err instanceof RepoLockedError ? `LOCKED ${err.state}` : `ERROR ${(err as Error).message}`);
    process.exit(0);
  }
} else {
  await main();
}

async function main() {
  const temp = await mkdtemp(path.join(tmpdir(), 'ai duo service smoke '));
  const dataDir = path.join(temp, 'runs');
  const repo = path.join(temp, 'repo with spaces');
  const plain = path.join(temp, 'plain folder');
  await Promise.all([mkdir(path.join(repo, 'sub'), { recursive: true }), mkdir(plain)]);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  await writeFile(path.join(repo, 'baseline.txt'), 'baseline\n');
  process.env.AI_DUO_DATA_DIR = dataDir;
  // Nothing in this test may reach a real CLI (the router's Haiku call falls back to rules).
  process.env.CLAUDE_BIN = path.join(temp, 'missing-claude.exe');
  process.env.CODEX_BIN = path.join(temp, 'missing-codex.exe');

  const { classifyByRules, CONFIDENT } = await import('./router/rules.ts');
  const [{ agents }, { AbortedError }, { RunService, ServiceError }, lockModule, { loadRun, saveRun }, { active }] = await Promise.all([
    import('./agents/index.ts'),
    import('./agents/process.ts'),
    import('./service.ts'),
    import('./lock.ts'),
    import('./store.ts'),
    import('./run.ts'),
  ]);
  const { lockTarget, readLockOwner, unlockRepo } = lockModule;

  const originals = { claude: { ...agents.claude }, codex: { ...agents.codex } };
  let check: (agent: AgentName) => AgentCheck = (agent) => ({ agent, path: agent, version: 'fake 1.0', auth: 'ok' });
  const checksRun: AgentName[] = [];
  for (const agent of ['claude', 'codex'] as const) {
    agents[agent].check = async () => {
      checksRun.push(agent);
      return check(agent);
    };
  }
  type Script = (agent: AgentName, o: RunOptions) => Promise<RunResult>;
  const calls: { agent: AgentName; role: string; prompt: string; allowUnverifiedAuth?: boolean }[] = [];
  let script: Script = async () => ({ finalText: 'unused' });
  for (const agent of ['claude', 'codex'] as const) {
    agents[agent].run = (o) => {
      calls.push({ agent, role: o.role, prompt: o.prompt, allowUnverifiedAuth: o.allowUnverifiedAuth });
      return script(agent, o);
    };
  }
  const hang: Script = (_agent, o) =>
    new Promise((_, reject) => {
      if (o.signal.aborted) reject(new AbortedError());
      o.signal.addEventListener('abort', () => reject(new AbortedError()), { once: true });
    });
  const approveAll: Script = async (agent, o) => {
    if (o.prompt.includes('Review this proposed implementation plan')) return { finalText: 'Solid. PLAN_VERDICT: APPROVE' };
    if (o.role === 'thinker') return { finalText: `Plan by ${agent}: edit output.txt, then verify.` };
    if (o.role === 'coder') {
      await writeFile(path.join(o.cwd, 'output.txt'), `written by ${agent}\n`);
      return { finalText: `Implemented by ${agent}.` };
    }
    return { finalText: '```json\n{"verdict":"APPROVE","tests":"pass","issues":[]}\n```' };
  };

  // Stands in for the Haiku call the router makes on prompts its rules cannot place.
  let classifyCalls = 0;
  const service = new RunService({
    app: 'smoke',
    classify: async () => {
      classifyCalls++;
      return { taskType: 'edit', complexity: 'light' };
    },
  });
  const lockFile = async (dir: string) => (await lockTarget(dir)).file;
  const expectError = async (promise: Promise<unknown>, code: string, pattern?: RegExp) => {
    const err = await promise.then(
      () => assert.fail(`expected a ${code} error`),
      (e: unknown) => e,
    );
    assert.ok(err instanceof ServiceError, `expected ServiceError, got ${err}`);
    assert.equal(err.code, code, err.message);
    if (pattern) assert.match(err.message, pattern);
    return err;
  };
  async function waitFor<T>(fn: () => T | undefined | false, what: string, ms = 10_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = fn();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const children: ReturnType<typeof spawn>[] = [];
  /** A second process holding the lock; resolves with its first output line. */
  function holder(dir: string, runId: string, crashAfter = false) {
    const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, '--hold', dir, runId, ...(crashAfter ? ['--crash'] : [])], { stdio: ['pipe', 'pipe', 'inherit'] });
    children.push(child);
    const line = new Promise<string>((resolve) => createInterface({ input: child.stdout! }).once('line', resolve));
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    return { child, line, exited, release: () => child.stdin!.write('go\n') };
  }

  try {
    const CODE = 'Implement and add a small change to output.txt.';
    const PLAN = 'Implement and add a settings panel to app.tsx.';

    // ---- Validation happens before any lock or agent call.
    await expectError(service.start({ mode: 'debate', prompt: 'x', cwd: repo }), 'invalid', /mode must be/);
    await expectError(service.start({ mode: 'code', prompt: '  ', cwd: repo }), 'invalid', /prompt is required/);
    await expectError(service.start({ mode: 'code', prompt: CODE, cwd: path.join(temp, 'missing') }), 'invalid', /Working directory not found/);
    await expectError(service.start({ mode: 'code', prompt: CODE, cwd: plain }), 'invalid', /needs a git repository/);
    assert.equal(checksRun.length, 0, 'invalid requests never reach preflight');
    assert.equal(existsSync(await lockFile(plain)), false);

    // ---- Preflight: runs after routing, before a run exists; always releases the lock.
    check = (agent) => ({ agent, path: agent, version: null, error: `${agent} is not installed`, auth: 'skipped' });
    const missing = await expectError(service.start({ mode: 'code', prompt: CODE, cwd: repo }), 'preflight', /is not installed/);
    assert.ok(missing.details.preflight?.checks.length, 'Code checks its routed coder and reviewer');
    assert.deepEqual(new Set(missing.details.preflight.checks.map((c) => c.agent)).size, missing.details.preflight.checks.length, 'each agent is checked once');
    assert.equal(calls.length, 0, 'no model was called');
    assert.equal(existsSync(await lockFile(repo)), false, 'a failed preflight releases the lock');
    assert.equal((await service.list()).length, 0, 'a failed preflight creates no run');

    check = (agent) => ({ agent, path: agent, version: 'fake', auth: 'failed', authError: `${agent} is not logged in` });
    await expectError(service.start({ mode: 'plan', prompt: PLAN, cwd: plain, skipAuthCheck: true }), 'preflight', /not logged in/);

    check = (agent) => ({ agent, path: agent, version: 'fake', auth: 'unknown', authError: `${agent} cannot report its login.` });
    await expectError(service.start({ mode: 'plan', prompt: PLAN, cwd: plain }), 'preflight', /--skip-auth-check/);
    script = hang;
    const skipped = await service.start({ mode: 'plan', prompt: PLAN, cwd: plain, skipAuthCheck: true });
    await waitFor(() => calls.length > 0, 'first turn');
    assert.equal(calls[0].allowUnverifiedAuth, true, 'the opt-in reaches the adapter');
    skipped.cancel();
    assert.equal((await skipped.done).status, 'cancelled');
    check = (agent) => ({ agent, path: agent, version: 'fake 1.0', auth: 'ok' });

    // ---- No model call before preflight: the router's classifier runs only once every agent passed.
    const UNCLEAR = 'hmm, ok';
    assert.ok(classifyByRules(UNCLEAR).confidence < CONFIDENT, 'the prompt needs the model classifier');
    calls.length = 0;
    checksRun.length = 0;
    check = (agent) => (agent === 'codex' ? { agent, path: agent, version: null, error: 'codex is not installed', auth: 'skipped' } : { agent, path: agent, version: 'fake', auth: 'ok' });
    await expectError(service.start({ mode: 'plan', prompt: UNCLEAR, cwd: plain }), 'preflight', /codex is not installed/);
    assert.equal(classifyCalls, 0, 'a failing agent stops the request before the classifier is called');
    assert.deepEqual([...new Set(checksRun)].sort((a, b) => a.localeCompare(b)), ['claude', 'codex'], 'the classifier and every routable agent are checked first');
    assert.equal(checksRun.length, 2, 'each agent is checked once per request');
    check = (agent) => ({ agent, path: agent, version: 'fake', auth: agent === 'claude' ? 'unknown' : 'ok', authError: 'cannot tell.' });
    script = hang;
    const rulesOnly = await service.start({ mode: 'plan', prompt: UNCLEAR, cwd: plain, skipAuthCheck: true });
    assert.equal(classifyCalls, 0, 'an unverified Claude login never runs the classifier; the rules decide');
    rulesOnly.cancel();
    await rulesOnly.done;
    check = (agent) => ({ agent, path: agent, version: 'fake 1.0', auth: 'ok' });
    const classified = await service.start({ mode: 'plan', prompt: UNCLEAR, cwd: plain });
    assert.equal(classifyCalls, 1, 'with every agent usable, the classifier settles the unclear prompt');
    assert.equal(classified.run.config.route?.source, 'haiku');
    classified.cancel();
    await classified.done;

    // ---- Plan outside Git: approval is flagged when offered, refused with a fix, and accepted after `git init`.
    script = approveAll;
    const late = path.join(temp, 'late repo');
    await mkdir(late);
    const noGit = await service.start({ mode: 'plan', prompt: PLAN, cwd: late });
    const offered = await waitFor(() => noGit.run.planDecision ?? undefined, 'plan approval outside Git');
    assert.match(offered.codeBlocked ?? '', /git init/);
    await expectError(noGit.answerPlanDecision({ action: 'approve' }), 'invalid', /git init/);
    await expectError(service.answerPlanDecision(noGit.id, { action: 'approve' }), 'invalid', /still waiting/);
    assert.ok(noGit.run.planDecision, 'a refused approval leaves the plan waiting');
    assert.equal(noGit.run.status, 'running');
    execFileSync('git', ['init', '-q'], { cwd: late });
    await service.answerPlanDecision(noGit.id, { action: 'approve' });
    const lateDone = await noGit.done;
    assert.equal(lateDone.status, 'done', lateDone.error);
    assert.equal(lateDone.config.mode, 'code');

    // ---- Plan: streaming, approval, then Code in the same run; lock held throughout and released after.
    calls.length = 0;
    script = approveAll;
    const events: RunEvent[] = [];
    const plan = await service.start({ mode: 'plan', prompt: PLAN, cwd: repo }, { onEvent: (e) => events.push(e) });
    assert.equal((await readLockOwner(await lockFile(repo)))?.runId, plan.id, 'the lock names the run');
    await waitFor(() => plan.run.planDecision, 'plan approval');
    assert.ok(events.some((e) => e.type === 'message.start' && e.message.agent === 'system'), 'the route note is streamed');
    assert.ok(events.some((e) => e.type === 'message.start' && e.message.phase === 'plan'));
    assert.ok(events.some((e) => e.type === 'message.end'));
    assert.ok(events.some((e) => e.type === 'run.update' && e.patch.planDecision));
    await expectError(service.start({ mode: 'code', prompt: CODE, cwd: path.join(repo, 'sub') }), 'conflict', /already active/);
    await plan.answerPlanDecision({ action: 'approve' });
    const implemented = await plan.done;
    assert.equal(implemented.status, 'done', implemented.error);
    assert.equal(implemented.config.mode, 'code');
    assert.ok(existsSync(path.join(repo, 'output.txt')), 'Code ran after approval');
    assert.ok(calls.some((c) => c.role === 'coder') && calls.some((c) => c.role === 'reviewer'));
    assert.equal(existsSync(await lockFile(repo)), false, 'the lock is released after the run is saved');
    assert.equal((await loadRun(plan.id))?.status, 'done');
    assert.equal(active.has(plan.id), false);

    // ---- Review limit: each decision grants 2 more rounds.
    calls.length = 0;
    script = async (_agent, o) => (o.role === 'reviewer' ? { finalText: '```json\n{"verdict":"CHANGES_REQUESTED","tests":"fail","issues":[]}\n```' } : { finalText: 'Tried again.' });
    const limited = await service.start({ mode: 'code', prompt: CODE, cwd: repo });
    const first = await waitFor(() => limited.run.pairDecision ?? undefined, 'first review-limit decision');
    assert.equal(first.extraRounds, 2);
    limited.answerPairDecision(true);
    await waitFor(() => (limited.run.pairDecision?.round ?? 0) > first.round, 'second decision');
    limited.answerPairDecision(false);
    const stopped = await limited.done;
    assert.equal(stopped.status, 'done');
    assert.equal(calls.filter((c) => c.role === 'reviewer').length, 4, '2 rounds + 2 granted rounds');
    assert.match(stopped.final ?? '', /Chưa được approve/);

    // ---- Follow-up continues the same thread; a second follow-up while it runs conflicts.
    script = hang;
    const followUp = await service.continue(limited.id, { mode: 'code', prompt: 'Fix the remaining test.' });
    assert.equal(followUp.id, limited.id);
    await expectError(service.continue(limited.id, { mode: 'code', prompt: 'again' }), 'conflict');
    await waitFor(() => followUp.run.messages.some((m) => m.agent === 'user' && m.parts[0]?.content === 'Fix the remaining test.'), 'follow-up message');

    // ---- Cancel (what Ctrl+C does in the CLI): agents stop, the run is saved as cancelled, the lock is freed.
    followUp.cancel();
    const cancelled = await followUp.done;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await loadRun(limited.id))?.status, 'cancelled');
    assert.equal(existsSync(await lockFile(repo)), false);

    // ---- One lock per repository, whatever path points into it; other folders are independent.
    script = hang;
    const holderRun = await service.start({ mode: 'code', prompt: CODE, cwd: repo });
    await expectError(service.start({ mode: 'plan', prompt: PLAN, cwd: path.join(repo, 'sub') }), 'conflict');
    if (process.platform === 'win32') await expectError(service.start({ mode: 'code', prompt: CODE, cwd: repo.toUpperCase() }), 'conflict');
    await expectError(service.start({ mode: 'code', prompt: CODE, cwd: `${repo}${path.sep}.${path.sep}sub${path.sep}..` }), 'conflict');
    const elsewhere = await service.start({ mode: 'plan', prompt: PLAN, cwd: plain });
    holderRun.cancel();
    elsewhere.cancel();
    await Promise.all([holderRun.done, elsewhere.done]);

    // ---- Another process holds the lock: conflict names it; a live owner cannot be unlocked.
    const other = holder(path.join(repo, 'sub'), 'other-process-run');
    assert.equal(await other.line, 'ACQUIRED');
    const conflict = await expectError(service.start({ mode: 'code', prompt: CODE, cwd: repo }), 'conflict', /other-process-run/);
    assert.equal(conflict.details.lock?.state, 'alive');
    assert.equal(conflict.details.lock?.owner?.pid, other.child.pid);
    assert.equal((await unlockRepo(repo)).result, 'refused');
    // A run the other process is running stays "running" when read from disk.
    await saveRun({ id: 'other-process-run', config: { mode: 'code', prompt: 'x', cwd: repo, maxRounds: 2, judge: 'claude', coder: 'codex', turnTimeoutMin: 1 }, status: 'running', createdAt: Date.now(), messages: [] });
    assert.equal((await loadRun('other-process-run'))?.status, 'running');
    await expectError(service.delete('other-process-run'), 'conflict');
    await expectError(service.rename('other-process-run', 'Renamed from the web'), 'conflict', /tiến trình khác/);
    other.release();
    await other.exited;
    assert.equal(await service.rename('other-process-run', 'Renamed later'), 'Renamed later', 'rename works once the owner is done');
    assert.equal(existsSync(await lockFile(repo)), false, 'the other process released on exit');
    assert.equal((await loadRun('other-process-run'))?.status, 'error', 'without a live owner it reads as interrupted');

    // ---- A process that dies keeps its lock (never removed for being old) until `unlock` sees it is gone.
    const crashed = holder(repo, 'crashed-run', true);
    assert.equal(await crashed.line, 'ACQUIRED');
    await crashed.exited;
    const stale = await expectError(service.start({ mode: 'code', prompt: CODE, cwd: repo }), 'conflict', /ai-duo unlock/);
    assert.equal(stale.details.lock?.state, 'dead');
    const unlocked = await unlockRepo(path.join(repo, 'sub'));
    assert.equal(unlocked.result, 'released');
    assert.equal((await unlockRepo(repo)).result, 'none');

    // ---- Two processes race for one repository through different paths: exactly one wins.
    const racers = [holder(repo, 'racer-a'), holder(path.join(repo, 'sub'), 'racer-b')];
    const results = await Promise.all(racers.map((r) => r.line));
    assert.deepEqual(results.map((r) => r.split(' ')[0]).sort((a, b) => a.localeCompare(b)), ['ACQUIRED', 'LOCKED'], results.join(', '));
    for (const racer of racers) racer.release();
    await Promise.all(racers.map((r) => r.exited));
    assert.equal(existsSync(await lockFile(repo)), false);

    console.log('PASS service validation, preflight, streaming, plan approval, review limit, follow-up, cancel, and cross-process repository lock');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    Object.assign(agents.claude, originals.claude);
    Object.assign(agents.codex, originals.codex);
    await service.abortAll();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(console.error);
  }
}
