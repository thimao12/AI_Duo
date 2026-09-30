/**
 * Smoke test for Code/Plan approval lifecycle, run cleanup, and project locking.
 *   pnpm --filter server test:lifecycle
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunEvent } from './types.ts';

const dataDir = await mkdtemp(path.join(tmpdir(), 'ai-duo-lifecycle-runs-'));
const routeCwd = await mkdtemp(path.join(tmpdir(), 'ai-duo-lifecycle-route-'));
process.env.AI_DUO_DATA_DIR = dataDir;
process.env.AI_DUO_ALLOWED_ROOTS = JSON.stringify([tmpdir()]);
execFileSync('git', ['init', '-q'], { cwd: routeCwd });
await writeFile(path.join(routeCwd, 'baseline.txt'), 'baseline\n');

const [{ agents }, { AbortedError, spawnJsonl }, { startServer, abortAll }, { active }] = await Promise.all([
  import('./agents/index.ts'),
  import('./agents/process.ts'),
  import('./app.ts'),
  import('./run.ts'),
]);

const originalClaude = agents.claude.run;
const originalCodex = agents.codex.run;
const originalChecks = { claude: agents.claude.check, codex: agents.codex.check };
// Mocked agents need no binary or login; preflight itself is covered by service-smoke.
for (const agent of ['claude', 'codex'] as const) agents[agent].check = async () => ({ agent, path: agent, version: 'mock', auth: 'ok' });
const server = await startServer({ port: 0 });
const base = server.url;
const request = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);
const postRun = (body: unknown) =>
  request('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function waitForRun(id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await request(`/api/runs/${id}`);
    assert.equal(response.status, 200);
    const run = await response.json();
    if (run.status !== 'running' && !active.has(id)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run ${id} did not finish in time`);
}

async function waitForPlanDecision(id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ctx = active.get(id);
    if (ctx?.run.planDecision) return ctx.run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Plan ${id} did not ask for approval`);
}

async function answerPlan(id: string, action: string, feedback?: string) {
  return request(`/api/runs/${id}/plan-decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, feedback }),
  });
}

try {
  const oldMode = await postRun({ mode: 'pair', cwd: dataDir, prompt: 'legacy mode must not start' });
  assert.equal(oldMode.status, 400, 'new runs accept only Code and Plan');
  const planPreviewResponse = await request('/api/route/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'plan', prompt: 'Implement and add a settings panel to app.tsx.' }),
  });
  const planPreview = await planPreviewResponse.json();
  assert.equal(planPreview.mode, 'plan');
  assert.equal(planPreview.reviewer, 'codex', 'light tasks may use the selected planner for both roles');

  // Plan runs pause for user approval, accept edits, and continue in the same thread.
  const planCalls: { agent: string; prompt: string; sessionId?: string }[] = [];
  let planReviews = 0;
  const mockPlanAgent = (agent: string) => async (options: { prompt: string; sessionId?: string }) => {
    planCalls.push({ agent, prompt: options.prompt, sessionId: options.sessionId });
    if (options.prompt.includes('Review this proposed implementation plan')) {
      planReviews++;
      const review = planReviews === 1
        ? 'Add a rollback step. PLAN_VERDICT: CHANGES_REQUESTED'
        : 'The plan is complete. PLAN_VERDICT: APPROVE';
      return { finalText: review, sessionId: `${agent}-session-smoke` };
    }
    return { finalText: `Plan draft from ${agent}: inspect files, implement changes, and verify.`, sessionId: `${agent}-session-smoke` };
  };
  agents.codex.run = mockPlanAgent('codex');
  agents.claude.run = mockPlanAgent('claude');
  const firstResponse = await postRun({ mode: 'plan', cwd: dataDir, prompt: 'Implement and add a settings panel to app.tsx.' });
  assert.equal(firstResponse.status, 200);
  const { id: threadId } = await firstResponse.json();
  const firstPending = await waitForPlanDecision(threadId);
  assert.equal(firstPending.config.mode, 'plan');
  assert.ok(firstPending.planDecision);
  assert.equal(firstPending.planDecision.reviewRounds, 2);
  assert.equal((await answerPlan(threadId, 'refine')).status, 400, 'refinement requires feedback');
  assert.equal((await answerPlan(threadId, 'refine', 'Include a rollback step.')).status, 200);
  const revisedPending = await waitForPlanDecision(threadId);
  assert.ok(revisedPending.planDecision);
  assert.equal(revisedPending.planDecision.revision, 1);
  assert.ok(revisedPending.messages.some((message: { agent: string; parts: { content: string }[] }) => message.agent === 'user' && message.parts[0].content === 'Include a rollback step.'));
  assert.equal((await answerPlan(threadId, 'stop')).status, 200);
  const firstDone = await waitForRun(threadId);
  assert.equal(firstDone.status, 'done');
  assert.equal(firstDone.config.mode, 'plan');
  assert.equal(firstDone.messages.some((message: { phase: string }) => message.phase === 'code'), false, 'choosing stop must not start Code');
  assert.ok(firstDone.final.includes('Plan draft from'));

  const image = { name: 'tiny.png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlOxKcAAAAASUVORK5CYII=' };
  const followResponse = await request(`/api/runs/${threadId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Explain how the settings panel works?', images: [image], mode: 'plan' }) });
  assert.equal(followResponse.status, 200);
  assert.equal((await followResponse.json()).id, threadId);
  await waitForPlanDecision(threadId);
  assert.equal((await answerPlan(threadId, 'stop')).status, 200);
  const followed = await waitForRun(threadId);
  const secondWriter = planCalls.find((call, index) => index > 0 && call.prompt.startsWith('You are a software architect working in read-only planning mode'));
  assert.ok(secondWriter?.sessionId, 'the follow-up resumes the selected plan writer session');
  assert.equal(followed.config.prompt, 'Implement and add a settings panel to app.tsx.');
  const userMessage = followed.messages.find((message: { agent: string; parts: { content: string }[] }) => message.agent === 'user' && message.parts[0].content === 'Explain how the settings panel works?');
  assert.ok(userMessage);
  assert.equal((await request(`/api/runs/${threadId}/messages/${userMessage.id}/images/0`)).status, 200);

  // Approving the reviewed plan routes Code automatically and implements in the same run.
  agents.codex.run = async (options) => {
    if (options.role === 'coder') {
      await writeFile(path.join(options.cwd, 'approved-plan-output.txt'), 'implemented\n');
      return { finalText: 'Implemented the approved plan.', sessionId: 'code-session-smoke' };
    }
    if (options.prompt.includes('Review this proposed implementation plan')) return { finalText: 'Plan looks good. PLAN_VERDICT: APPROVE', sessionId: 'plan-review-smoke' };
    return { finalText: 'Plan: update the settings component and verify it.' , sessionId: 'plan-writer-smoke' };
  };
  agents.claude.run = async (options) => {
    if (options.role === 'reviewer') return { finalText: '```json\n{"verdict":"APPROVE","tests":"pass","issues":[]}\n```', sessionId: 'code-review-smoke' };
    return { finalText: 'Plan review complete. PLAN_VERDICT: APPROVE', sessionId: 'plan-review-smoke' };
  };
  const approvalStart = await postRun({ mode: 'plan', cwd: routeCwd, prompt: 'Implement, add, and create a settings panel in app.tsx with a test.' });
  assert.equal(approvalStart.status, 200);
  const { id: approvalId } = await approvalStart.json();
  await waitForPlanDecision(approvalId);
  assert.equal((await answerPlan(approvalId, 'approve')).status, 200);
  const implemented = await waitForRun(approvalId);
  assert.equal(implemented.config.mode, 'code');
  assert.ok(implemented.messages.some((message: { agent: string; phase: string }) => message.agent === 'codex' && message.phase === 'code'));
  assert.ok(implemented.messages.some((message: { agent: string; phase: string }) => message.agent === 'claude' && message.phase === 'review'));
  assert.match(implemented.final, /approve after|approve/);

  // A failed Code turn is closed and persisted without leaving a running message.
  agents.claude.run = async () => ({ finalText: 'unused' });
  agents.codex.run = async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    throw new Error('Failed to start codex: simulated missing binary');
  };

  const failedResponse = await postRun({ mode: 'code', cwd: routeCwd, prompt: 'Implement and add a button to app.tsx.' });
  assert.equal(failedResponse.status, 200);
  const { id: failedId } = await failedResponse.json();
  const failedContext = active.get(failedId)!;
  const failureEvents: RunEvent[] = [];
  const unsubscribeFailureEvents = failedContext.subscribe((event) => failureEvents.push(event));
  const failedRun = await waitForRun(failedId);
  unsubscribeFailureEvents();
  assert.equal(failedRun.status, 'error');
  assert.match(failedRun.error, /simulated missing binary/);
  assert.ok(failedRun.messages.every((message: { status: string }) => message.status !== 'running'));
  const messageText = failedRun.messages.flatMap((message: { parts: { content: string }[] }) => message.parts.map((part) => part.content)).join('\n');
  assert.doesNotMatch(messageText, /Cancelled/);
  const failedTurnId = failedRun.messages.find((message: { agent: string; status: string }) => message.agent === 'codex' && message.status === 'error').id;
  assert.ok(failureEvents.some((event) => event.type === 'message.end' && event.id === failedTurnId));
  const savedRun = JSON.parse(await readFile(path.join(dataDir, `${failedId}.json`), 'utf8'));
  assert.ok(savedRun.messages.every((message: { status: string }) => message.status !== 'running'));

  const controller = new AbortController();
  const child = spawnJsonl(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: dataDir,
    stdin: '',
    signal: controller.signal,
    timeoutMs: 5_000,
    onJson: () => {},
    onRawLine: () => {},
  });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(child, AbortedError);

  // An active Code run reserves its canonical repo path, including case variants on Windows.
  agents.codex.run = ({ signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new AbortedError()), { once: true });
    });
  agents.claude.run = async () => ({ finalText: 'unused' });
  // Throwaway repo: the pair run snapshots its working tree, so keep it off the real one.
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-duo-lifecycle-repo-'));
  execFileSync('git', ['init', '-q'], { cwd });
  const caseVariant = process.platform === 'win32' ? cwd.toUpperCase() : cwd;
  const pairResponse = await postRun({ mode: 'code', cwd, prompt: 'Implement and add a small change.' });
  assert.equal(pairResponse.status, 200);
  const { id: pairId } = await pairResponse.json();
  const conflict = await postRun({ mode: 'code', cwd: caseVariant, prompt: 'must be rejected' });
  assert.equal(conflict.status, 409);
  await request(`/api/runs/${pairId}/cancel`, { method: 'POST' });
  const cancelledRun = await waitForRun(pairId);
  assert.equal(cancelledRun.status, 'cancelled');
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(console.error);

  console.log('PASS Code/Plan routing and approval lifecycle, run cleanup, process abort, and project lock');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  agents.claude.run = originalClaude;
  agents.codex.run = originalCodex;
  Object.assign(agents.claude, { check: originalChecks.claude });
  Object.assign(agents.codex, { check: originalChecks.codex });
  void abortAll();
  const cleanupDeadline = Date.now() + 5_000;
  while (active.size && Date.now() < cleanupDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
  await server.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(console.error);
  await rm(routeCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(console.error);
}
