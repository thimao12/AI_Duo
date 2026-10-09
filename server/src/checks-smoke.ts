import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectChecks, runCheckResults } from './checks.ts';
import { diagnosticsRoutes } from './routes/diagnostics.ts';

const root = await mkdtemp(path.join(tmpdir(), 'ai-duo-checks-'));
process.env.AI_DUO_ALLOWED_ROOTS = JSON.stringify([root]);
try {
  assert.deepEqual(detectChecks(root), [], 'a bare folder has no checks');

  // tsc needs both a tsconfig and the typescript dependency; Biome wins over ESLint; Ruff comes from its config.
  await writeFile(path.join(root, 'tsconfig.json'), '{}');
  assert.deepEqual(detectChecks(root).map((c) => c.name), [], 'tsconfig alone is not enough');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { typescript: '^5' } }));
  await writeFile(path.join(root, 'biome.json'), '{}');
  await writeFile(path.join(root, 'eslint.config.js'), '');
  await writeFile(path.join(root, 'ruff.toml'), '');
  assert.deepEqual(detectChecks(root).map((c) => c.name), ['tsc', 'biome', 'ruff']);

  // A check that cannot run reports a failure rather than throwing.
  const results = await runCheckResults(root);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => typeof r.ok === 'boolean'));

  // The route validates its input and shapes the result.
  const app = diagnosticsRoutes(async () => [{ name: 'tsc', ok: false, output: 'error TS1' }, { name: 'biome', ok: true, output: '' }]);
  const post = (body: unknown) => app.request('/api/diagnostics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({})).status, 400);
  const res = await post({ cwd: root });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false, checks: [{ name: 'tsc', ok: false, output: 'error TS1' }, { name: 'biome', ok: true, output: '' }] });

  console.log('PASS checks: detection, failure reporting, diagnostics route');
} finally {
  await rm(root, { recursive: true, force: true });
}
