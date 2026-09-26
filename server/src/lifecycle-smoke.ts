/**
 * Smoke test for run cleanup and pair repository locking.
 *   pnpm --filter server test:lifecycle
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunEvent } from './types.ts';

const dataDir = await mkdtemp(path.join(tmpdir(), 'ai-duo-lifecycle-runs-'));
process.env.AI_DUO_DATA_DIR = dataDir;

const [{ agents }, { AbortedError, spawnJsonl }, { startServer, abortAll }, { active }] = await Promise.all([
  import('./agents/index.ts'),
  import('./agents/process.ts'),
  import('./app.ts'),
  import('./run.ts'),
]);

const originalClaude = agents.claude.run;
const originalCodex = agents.codex.run;
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

try {
  // A follow-up stays in the same run and resumes the same CLI conversation.
  const sessionIds: (string | undefined)[] = [];
  agents.codex.run = async (options) => {
    sessionIds.push(options.sessionId);
    return { finalText: `answer ${sessionIds.length}`, sessionId: 'codex-session-smoke' };
  };
  const firstResponse = await postRun({ mode: 'plan', cwd: dataDir, prompt: 'first question' });
  assert.equal(firstResponse.status, 200);
  const { id: threadId } = await firstResponse.json();
  await waitForRun(threadId);
  const image = { name: 'tiny.png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlOxKcAAAAASUVORK5CYII=' };
  const followResponse = await request(`/api/runs/${threadId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'second question', images: [image], mode: 'plan' }) });
  assert.equal(followResponse.status, 200);
  assert.equal((await followResponse.json()).id, threadId);
  const followed = await waitForRun(threadId);
  assert.deepEqual(sessionIds, [undefined, 'codex-session-smoke']);
  assert.equal(followed.config.prompt, 'first question');
  const userMessage = followed.messages.find((message: { agent: string }) => message.agent === 'user');
  assert.equal(userMessage.parts[0].content, 'second question');
  assert.equal((await request(`/api/runs/${threadId}/messages/${userMessage.id}/images/0`)).status, 200);
  assert.equal(followed.final, 'answer 2');

  // A new task in the same thread is routed again instead of inheriting plan mode.
  agents.claude.run = async () => ({ finalText: 'Claude response' });
  const reroutedResponse = await request('/api/runs/' + threadId + '/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Giải thích tại sao hàm này hoạt động như vậy?', mode: 'auto' }) });
  assert.equal(reroutedResponse.status, 200);
  const rerouted = await waitForRun(threadId);
  assert.equal(rerouted.config.mode, 'debate');
  assert.equal(rerouted.config.route.taskType, 'explain');
  assert.ok(rerouted.messages.some((message: { title: string }) => message.title === 'Định tuyến tự động'));

  // A failed agent aborts and waits for its sibling before the final run is saved.
  agents.claude.run = ({ signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new AbortedError()), { once: true });
    });
  agents.codex.run = async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    throw new Error('Failed to start codex: simulated missing binary');
  };

  const debateResponse = await postRun({ mode: 'debate', cwd: dataDir, prompt: 'lifecycle smoke' });
  assert.equal(debateResponse.status, 200);
  const { id: debateId } = await debateResponse.json();
  const failedContext = active.get(debateId)!;
  const failureEvents: RunEvent[] = [];
  const unsubscribeFailureEvents = failedContext.subscribe((event) => failureEvents.push(event));
  const failedRun = await waitForRun(debateId);
  unsubscribeFailureEvents();
  assert.equal(failedRun.status, 'error');
  assert.match(failedRun.error, /simulated missing binary/);
  assert.ok(failedRun.messages.every((message: { status: string }) => message.status !== 'running'));
  const messageText = failedRun.messages.flatMap((message: { parts: { content: string }[] }) => message.parts.map((part) => part.content)).join('\n');
  assert.doesNotMatch(messageText, /Cancelled/);
  assert.match(messageText, /Stopped: run ended/);
  const siblingId = failedRun.messages.find((message: { agent: string }) => message.agent === 'claude').id;
  assert.ok(failureEvents.some((event) => event.type === 'message.end' && event.id === siblingId));
  const savedRun = JSON.parse(await readFile(path.join(dataDir, `${debateId}.json`), 'utf8'));
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

  // An active pair reserves its canonical repo path, including case variants on Windows.
  agents.codex.run = ({ signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new AbortedError()), { once: true });
    });
  agents.claude.run = async () => ({ finalText: 'unused' });
  // Throwaway repo: the pair run snapshots its working tree, so keep it off the real one.
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-duo-lifecycle-repo-'));
  execFileSync('git', ['init', '-q'], { cwd });
  const caseVariant = process.platform === 'win32' ? cwd.toUpperCase() : cwd;
  const pairResponse = await postRun({ mode: 'pair', cwd, prompt: 'pair lock smoke' });
  assert.equal(pairResponse.status, 200);
  const { id: pairId } = await pairResponse.json();
  const conflict = await postRun({ mode: 'pair', cwd: caseVariant, prompt: 'must be rejected' });
  assert.equal(conflict.status, 409);
  await request(`/api/runs/${pairId}/cancel`, { method: 'POST' });
  const cancelledRun = await waitForRun(pairId);
  assert.equal(cancelledRun.status, 'cancelled');
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(console.error);

  console.log('PASS failed-run cleanup, persisted message status, process abort, and pair repo lock');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  agents.claude.run = originalClaude;
  agents.codex.run = originalCodex;
  abortAll();
  const cleanupDeadline = Date.now() + 5_000;
  while (active.size && Date.now() < cleanupDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
  await server.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(console.error);
}
