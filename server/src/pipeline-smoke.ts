/**
 * Smoke test for role and pipeline runs with fake agents: read-only runs need no Git repository or
 * lock, edit roles do, {{prev}} carries the previous output, a failing gradable step loops back
 * (bounded by maxLoops), precedence of explicit request fields, and cancellation.
 *   pnpm --filter server test:pipeline
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findExecutable } from '../../shared/exe.ts';
import type { AgentCheck, AgentName, RunOptions, RunResult } from './agents/types.ts';

const temp = await mkdtemp(path.join(tmpdir(), 'ai duo pipeline smoke '));
const repo = path.join(temp, 'repo');
const plain = path.join(temp, 'plain folder');
await Promise.all([mkdir(repo), mkdir(plain)]);
execFileSync(findExecutable('git') ?? 'git', ['init', '-q'], { cwd: repo });
process.env.AI_DUO_DATA_DIR = path.join(temp, 'runs');
process.env.AI_DUO_SETTINGS_FILE = path.join(temp, 'settings.json');
process.env.AI_DUO_ALLOWED_ROOTS = JSON.stringify([temp]);
process.env.CLAUDE_BIN = path.join(temp, 'missing-claude.exe');
process.env.CODEX_BIN = path.join(temp, 'missing-codex.exe');

const [{ agents }, { AbortedError }, { RunService, ServiceError }, settings, { listRuns }] = await Promise.all([
  import('./agents/index.ts'),
  import('./agents/process.ts'),
  import('./service.ts'),
  import('./settings.ts'),
  import('./store.ts'),
]);

const originals = { claude: { ...agents.claude }, codex: { ...agents.codex } };
const calls: { agent: AgentName; role: string; permission?: string; model?: string; effort?: string; prompt: string }[] = [];
let script: (agent: AgentName, o: RunOptions, n: number) => Promise<RunResult> = () => Promise.resolve({ finalText: 'unused' });
for (const agent of ['claude', 'codex'] as const) {
  agents[agent].check = (): Promise<AgentCheck> => Promise.resolve({ agent, path: agent, version: 'fake', auth: 'ok' });
  agents[agent].run = (o) => {
    calls.push({ agent, role: o.role, permission: o.permission, model: o.model, effort: o.effort, prompt: o.prompt });
    return script(agent, o, calls.length);
  };
}

const service = new RunService({ app: 'smoke' });
const expectError = async (promise: Promise<unknown>, code: string, pattern: RegExp) => {
  const err = await promise.then(() => assert.fail(`expected ${code}`), (e: unknown) => e);
  assert.ok(err instanceof ServiceError && err.code === code, String(err));
  assert.match((err as Error).message, pattern);
};
const runToEnd = async (body: Parameters<typeof service.start>[0]) => (await service.start(body)).done;

try {
  const reply = (finalText: string) => Promise.resolve({ finalText });

  // ---- A read-only role runs in a folder that is not a Git repository, with its own agent, model and permission.
  script = () => reply('The answer.');
  const ask = await runToEnd({ mode: 'code', roleId: 'ask', prompt: 'What does main do?', cwd: plain });
  assert.equal(ask.status, 'done', ask.error);
  assert.equal(ask.final, 'The answer.');
  assert.deepEqual(calls.map((c) => [c.agent, c.role, c.permission, c.model]), [['claude', 'thinker', 'read', 'haiku']]);
  assert.match(calls[0].prompt, /What does main do\?/);
  assert.equal(ask.config.route, undefined, 'a role bypasses the router');
  assert.equal((await listRuns()).find((r) => r.id === ask.id)?.agent, 'claude');

  // ---- Precedence: explicit request fields > role > router.
  calls.length = 0;
  await runToEnd({ mode: 'code', roleId: 'ask', prompt: 'q', cwd: plain, coder: 'codex', models: { codex: 'gpt-x' }, efforts: { codex: 'low' } });
  assert.deepEqual([calls[0].agent, calls[0].model, calls[0].effort], ['codex', 'gpt-x', 'low'], 'request agent/model win over the role');
  calls.length = 0;
  await runToEnd({ mode: 'code', permission: 'read', prompt: 'explain this', cwd: plain });
  assert.deepEqual([calls[0].agent, calls[0].permission], ['claude', 'read'], 'permission alone is a read-only run with no router');

  // ---- Edit roles keep the Git requirement; a read-only permission override lifts it.
  await expectError(service.start({ mode: 'code', roleId: 'code', prompt: 'x', cwd: plain }), 'invalid', /Git/i);
  calls.length = 0;
  const coded = await runToEnd({ mode: 'code', roleId: 'code', prompt: 'add a thing', cwd: repo });
  assert.equal(coded.status, 'done', coded.error);
  assert.deepEqual([calls[0].role, calls[0].permission, calls[0].model, calls[0].effort], ['coder', 'edit', 'sonnet', 'medium']);
  assert.equal((await runToEnd({ mode: 'code', roleId: 'code', permission: 'read', prompt: 'x', cwd: plain })).status, 'done');
  await expectError(service.start({ mode: 'code', roleId: 'missing', prompt: 'x', cwd: repo }), 'invalid', /not found/);
  await expectError(service.start({ mode: 'plan', roleId: 'ask', prompt: 'x', cwd: repo }), 'invalid', /roleId/);
  await expectError(service.start({ mode: 'code', roleId: 'Bad Id', prompt: 'x', cwd: repo }), 'invalid', /valid id/);
  await expectError(service.start({ mode: 'pipeline', prompt: 'x', cwd: repo }), 'invalid', /pipelineId/);
  await expectError(service.start({ mode: 'pipeline', pipelineId: 'nope', prompt: 'x', cwd: repo }), 'invalid', /không tồn tại/);

  // ---- Pipeline: Plan -> Review; Review fails once, sending the plan back with the review as {{prev}}.
  const saved = await settings.setPipelines([
    { id: 'plan-review', name: 'Plan and review', steps: [{ roleId: 'plan' }, { roleId: 'review', onFail: 0, maxLoops: 2 }] },
    { id: 'strict', name: 'Strict', steps: [{ roleId: 'plan' }, { roleId: 'review', onFail: 0, maxLoops: 1 }] },
    { id: 'no-loop', name: 'No loop', steps: [{ roleId: 'plan' }, { roleId: 'review' }, { roleId: 'ask' }] },
    { id: 'build', name: 'Build', steps: [{ roleId: 'plan' }, { roleId: 'code' }] },
  ]);
  assert.ok(Array.isArray(saved));

  calls.length = 0;
  let reviews = 0;
  script = (_agent, o, n) => {
    if (o.prompt.includes('người review')) return reply(++reviews === 1 ? 'Missing tests.\nVERDICT: FAIL' : 'Looks good.\nVERDICT: PASS');
    return reply(`PLAN-${n}`);
  };
  const piped = await runToEnd({ mode: 'pipeline', pipelineId: 'plan-review', prompt: 'Build the thing', cwd: plain });
  assert.equal(piped.status, 'done', piped.error);
  assert.equal(piped.config.mode, 'pipeline');
  assert.equal(calls.length, 4, 'plan, review (fail), plan, review (pass)');
  assert.deepEqual(calls.map((c) => c.agent), ['claude', 'codex', 'claude', 'codex']);
  assert.ok(calls.every((c) => c.permission === 'read'));
  assert.match(calls[0].prompt, /Build the thing/);
  assert.match(calls[1].prompt, /PLAN-1/, 'the review sees the plan as {{prev}}');
  assert.match(calls[2].prompt, /Missing tests\./, 'the fixing step sees the failed review as {{prev}}');
  assert.match(calls[3].prompt, /PLAN-3/);
  assert.equal(piped.final, 'Looks good.\nVERDICT: PASS');
  assert.deepEqual(piped.messages.filter((m) => m.phase === 'role').map((m) => m.verdict), [undefined, 'CHANGES_REQUESTED', undefined, 'APPROVE']);
  assert.ok(piped.messages.some((m) => m.title === 'Quay lại bước trước'));

  // ---- The loop is bounded by maxLoops.
  calls.length = 0;
  script = (_agent, o, n) => reply(o.prompt.includes('người review') ? 'No.\nVERDICT: FAIL' : `PLAN-${n}`);
  const strict = await runToEnd({ mode: 'pipeline', pipelineId: 'strict', prompt: 'x', cwd: plain });
  assert.equal(strict.status, 'error');
  assert.match(strict.error ?? '', /1 vòng lặp/);
  assert.equal(calls.length, 4, 'plan, review, plan, review, then it gives up');

  // ---- A failing step with no onFail stops the pipeline without an error; a missing grade counts as a fail.
  calls.length = 0;
  script = (_agent, o) => reply(o.prompt.includes('người review') ? 'No grade given.' : 'PLAN');
  const stopped = await runToEnd({ mode: 'pipeline', pipelineId: 'no-loop', prompt: 'x', cwd: plain });
  assert.equal(stopped.status, 'done');
  assert.equal(calls.length, 2, 'the Ask step never ran');
  assert.ok(stopped.messages.some((m) => m.title === 'Pipeline dừng'));

  // ---- An edit step needs a Git repository and takes the lock; the run records its diff.
  await expectError(service.start({ mode: 'pipeline', pipelineId: 'build', prompt: 'x', cwd: plain }), 'invalid', /Git/i);
  calls.length = 0;
  script = (_agent, o) => reply(`done by ${o.role}`);
  const built = await runToEnd({ mode: 'pipeline', pipelineId: 'build', prompt: 'x', cwd: repo });
  assert.equal(built.status, 'done', built.error);
  assert.deepEqual(calls.map((c) => c.permission), ['read', 'edit']);
  assert.equal(built.diff, '', 'diff is recorded for pipelines that can edit');
  assert.match(calls[1].prompt, /done by thinker/);

  // ---- Cancelling stops the pipeline between and during steps.
  calls.length = 0;
  script = (_agent, o) => new Promise((_, reject) => {
    o.signal.addEventListener('abort', () => reject(new AbortedError()), { once: true });
  });
  const handle = await service.start({ mode: 'pipeline', pipelineId: 'plan-review', prompt: 'x', cwd: plain });
  handle.cancel();
  assert.equal((await handle.done).status, 'cancelled');
  assert.equal(calls.length <= 1, true);

  console.log('PASS pipeline: read-only roles without git, edit roles with git, {{prev}}, pass/fail branching, maxLoops, precedence, cancel');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  Object.assign(agents.claude, originals.claude);
  Object.assign(agents.codex, originals.codex);
  await service.abortAll();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(console.error);
}
