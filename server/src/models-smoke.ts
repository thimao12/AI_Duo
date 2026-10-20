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
process.env.AI_DUO_ALLOWED_ROOTS = JSON.stringify([temp]);
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

const [{ listModels, codexDefaults, parseAgyModels, refreshModels, resetModelCache }, { RunContext }, { startServer }] = await Promise.all([import('./models.ts'), import('./run.ts'), import('./app.ts')]);

try {
  const catalog = listModels({ ...process.env, CODEX_HOME: codexHome });
  assert.deepEqual(catalog.codex.models.map((m) => m.id), ['gpt-a'], 'hidden models are left out');
  assert.deepEqual(catalog.codex.models[0].efforts, ['low', 'medium', 'high'], 'invalid effort names are dropped');
  assert.deepEqual(catalog.codex.default, { model: 'gpt-a', effort: 'high' }, 'only top-level config keys count');
  assert.deepEqual(catalog.claude.models.map((m) => [m.id, m.name]), [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']], 'Claude shows the exact versions');

  // Claude's own settings add full ids; Fable is never offered, from any source.
  const claudeHome = path.join(temp, 'claude');
  await import('node:fs/promises').then((fs) => fs.mkdir(claudeHome));
  await writeFile(path.join(claudeHome, 'settings.json'), JSON.stringify({ model: 'claude-fable-5-1', availableModels: ['claude-sonnet-4-6', 'opus', 'claude-fable-5-1', 'claude-sonnet-5-5'] }));
  const withLocal = listModels({ ...process.env, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome });
  assert.deepEqual(withLocal.claude.models.map((m) => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-4-6']);
  assert.equal(withLocal.claude.models[3].name, 'Sonnet 4.6');
  assert.ok(!Object.values(withLocal).some((a) => a.models.some((m) => /fable/i.test(m.id))));

  // `agy models` output becomes the Antigravity list; a failing CLI keeps the fallback.
  const agyOut = ['Fetching available models...', 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)', 'claude-fable-5-1\tFable', 'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)', ''].join('\r\n');
  assert.deepEqual(parseAgyModels(agyOut).map((m) => m.id), ['gemini-3.8-flash-high', 'gpt-oss-120b-medium']);
  resetModelCache();
  const failing = await refreshModels({ ...process.env, CODEX_HOME: codexHome }, () => Promise.reject(new Error('no agy')));
  assert.ok(failing.antigravity.models.length > 3, 'fallback list when agy cannot answer');
  resetModelCache();
  let asked = 0;
  const ask = () => (asked++, Promise.resolve(agyOut));
  const listed = await refreshModels({ ...process.env, CODEX_HOME: codexHome }, ask);
  assert.deepEqual(listed.antigravity.models.map((m) => m.id), ['gemini-3.8-flash-high', 'gpt-oss-120b-medium']);
  await refreshModels({ ...process.env, CODEX_HOME: codexHome }, ask);
  assert.equal(asked, 1, 'the answer is kept for a while');
  resetModelCache();
  assert.deepEqual(listModels({ ...process.env, CODEX_HOME: path.join(temp, 'missing') }).codex, { models: [], default: {} });
  await writeFile(path.join(codexHome, 'config.toml'), `${' '.repeat(200_000)}\n  model = "first" # comment\r\nmodel = "second"\nmodel_reasoning_effort = "medium"\n   [profiles.x]\nmodel = "ignored"\n`);
  assert.deepEqual(codexDefaults({ CODEX_HOME: codexHome }), { model: 'first', effort: 'medium' });
  await writeFile(path.join(codexHome, 'config.toml'), 'model = not-quoted\nmodel = "valid"\nmodel_reasoning_effort = "unclosed\n');
  assert.deepEqual(codexDefaults({ CODEX_HOME: codexHome }), { model: 'valid', effort: undefined });

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
    await Promise.all([{ codex: 'high; rm -rf' }, { claude: '--max' }, { codex: 5 }].map(async (bad) => {
      const res = await post(bad);
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /Invalid efforts/);
    }));
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
