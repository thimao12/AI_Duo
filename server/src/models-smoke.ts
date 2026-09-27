/**
 * Smoke test for the model catalog (Codex cache + config.toml), manual model/effort
 * precedence over the router, and effort validation.
 *   pnpm --filter server test:models
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = await mkdtemp(path.join(tmpdir(), 'ai-duo-models-'));
process.env.AI_DUO_DATA_DIR = path.join(temp, 'runs');
const codexHome = path.join(temp, 'codex');
await import('node:fs/promises').then((fs) => fs.mkdir(codexHome));

await writeFile(
  path.join(codexHome, 'models_cache.json'),
  JSON.stringify({
    models: [
      { slug: 'gpt-a', display_name: 'GPT-A', description: 'Big', default_reasoning_level: 'medium', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'BAD LEVEL' }] },
      { slug: 'hidden-one', display_name: 'Hidden', visibility: 'hide', supported_reasoning_levels: [] },
    ],
  }),
);
await writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-a"\nmodel_reasoning_effort = "high"\n\n[profiles.x]\nmodel = "ignored"\n');

const [{ listModels }, { RunContext }, { startServer }] = await Promise.all([import('./models.ts'), import('./run.ts'), import('./app.ts')]);

try {
  const catalog = listModels({ ...process.env, CODEX_HOME: codexHome });
  assert.deepEqual(catalog.codex.models.map((m) => m.id), ['gpt-a'], 'hidden models are left out');
  assert.deepEqual(catalog.codex.models[0].efforts, ['low', 'medium', 'high'], 'invalid effort names are dropped');
  assert.deepEqual(catalog.codex.default, { model: 'gpt-a', effort: 'high' }, 'only top-level config keys count');
  assert.ok(catalog.claude.models.some((m) => m.id === 'opus'));
  assert.deepEqual(listModels({ ...process.env, CODEX_HOME: path.join(temp, 'missing') }).codex, { models: [], default: {} });

  const route = { taskType: 'edit', complexity: 'standard', source: 'rules', reason: '', models: { codex: { coder: { model: 'routed', effort: 'low', tier: 'standard' } } } } as const;
  const base = { mode: 'code', prompt: 'x', cwd: temp, maxRounds: 1, judge: 'claude', coder: 'codex', turnTimeoutMin: 1, route } as const;
  const pick = (extra: object) => new RunContext({ ...base, ...extra } as any).modelFor('codex', 'coder');
  assert.deepEqual(pick({}), { model: 'routed', effort: 'low' }, 'router pick by default');
  assert.deepEqual(pick({ efforts: { codex: 'high' } }), { model: 'routed', effort: 'high' }, 'manual effort overrides routed effort');
  assert.deepEqual(pick({ models: { codex: 'gpt-a' } }), { model: 'gpt-a' }, 'manual model drops the routed effort');
  assert.deepEqual(pick({ models: { codex: 'gpt-a' }, efforts: { codex: 'medium' } }), { model: 'gpt-a', effort: 'medium' });

  const server = await startServer({ port: 0 });
  try {
    const post = (efforts: unknown) =>
      fetch(`${server.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'code', prompt: 'x', cwd: path.join(temp, 'no such dir'), efforts }),
      });
    for (const bad of [{ codex: 'high; rm -rf' }, { claude: '--max' }, { codex: 5 }]) {
      const res = await post(bad);
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /Invalid efforts/);
    }
    // A valid effort passes validation and fails later on the missing cwd instead.
    const ok = await post({ codex: 'high' });
    assert.doesNotMatch((await ok.json()).error, /Invalid efforts/);
    const models = await (await fetch(`${server.url}/api/models`)).json();
    assert.ok(Array.isArray(models.codex.models) && Array.isArray(models.claude.models));
  } finally {
    await server.close();
  }
  console.log('PASS model catalog, manual model/effort precedence, and effort validation');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}
