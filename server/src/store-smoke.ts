/**
 * Smoke test for serialized run writes, immediate checkpoints, and restart recovery.
 *   pnpm --filter server test:store
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Run } from './types.ts';

const dataDir = await mkdtemp(path.join(tmpdir(), 'ai-duo-store-runs-'));
process.env.AI_DUO_DATA_DIR = dataDir;

const [{ loadRun, saveRun }, { RunContext }] = await Promise.all([import('./store.ts'), import('./run.ts')]);

const makeRun = (id: string): Run => ({
  id,
  config: {
    mode: 'debate',
    prompt: 'store smoke',
    cwd: dataDir,
    maxRounds: 1,
    judge: 'claude',
    coder: 'codex',
    turnTimeoutMin: 1,
  },
  status: 'running',
  createdAt: Date.now(),
  messages: [],
});

async function waitForFile(id: string, predicate: (run: Run) => boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const run = JSON.parse(await readFile(path.join(dataDir, `${id}.json`), 'utf8')) as Run;
      if (predicate(run)) return run;
    } catch {
      // The first checkpoint may not have reached disk yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run ${id} was not checkpointed in time`);
}

try {
  const parallelRun = makeRun('parallel-save-smoke');
  await Promise.all(Array.from({ length: 100 }, (_, index) => {
    parallelRun.final = `snapshot-${index}`;
    return saveRun(parallelRun);
  }));
  const saved = JSON.parse(await readFile(path.join(dataDir, `${parallelRun.id}.json`), 'utf8')) as Run;
  assert.equal(saved.final, 'snapshot-99');
  assert.deepEqual((await readdir(dataDir)).filter((name) => name.endsWith('.tmp')), []);

  const ctx = new RunContext(makeRun('unused').config);
  const initial = await waitForFile(ctx.run.id, (run) => run.status === 'running');
  assert.deepEqual(initial.messages, [], 'a new run should be saved before its first message');
  (ctx as any).startMessage('system', 'info', 0, 'checkpoint smoke');
  const started = await waitForFile(ctx.run.id, (run) => run.messages.some((message) => message.title === 'checkpoint smoke'));
  const checkpointMessage = started.messages.find((message) => message.title === 'checkpoint smoke')!;
  assert.equal(checkpointMessage.status, 'running', 'message start should be checkpointed before it ends');
  await ctx.finish('done');

  const interrupted = makeRun('interrupted-smoke');
  interrupted.messages.push({
    id: 'message-smoke',
    agent: 'claude',
    phase: 'proposal',
    round: 1,
    title: 'proposal',
    parts: [{ kind: 'text', content: 'partial output' }],
    status: 'running',
    startedAt: Date.now(),
  });
  await writeFile(path.join(dataDir, `${interrupted.id}.json`), JSON.stringify(interrupted), 'utf8');
  const recovered = await loadRun(interrupted.id);
  assert.equal(recovered?.status, 'error');
  assert.equal(recovered?.error, 'Interrupted (server restarted)');
  assert.equal(recovered?.messages[0].status, 'error');
  assert.ok(recovered?.messages[0].parts.some((part) => part.kind === 'error' && part.content === 'Interrupted (server restarted)'));

  console.log('PASS 100 serialized writes, immediate checkpoints, and interrupted run recovery');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(console.error);
}
