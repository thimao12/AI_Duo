import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectChecks, runCheckResults } from './checks.ts';
import { fixPrompt, parseDiagnostics } from './diagnostics.ts';
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
  const app = diagnosticsRoutes(async () => [{ name: 'tsc', ok: false, output: 'error TS1', diagnostics: [] }, { name: 'biome', ok: true, output: '', diagnostics: [] }]);
  const post = (body: unknown) => app.request('/api/diagnostics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({})).status, 400);
  const res = await post({ cwd: root });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false, checks: [{ name: 'tsc', ok: false, output: 'error TS1', diagnostics: [] }, { name: 'biome', ok: true, output: '', diagnostics: [] }] });

  // Parsers: tsc (paths relative to the project), ruff, ESLint stylish, Biome headers.
  const abs = path.join(root, 'src', 'a.ts');
  const tsc = parseDiagnostics('tsc', [`src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.`, `${abs}(3,1): error TS2304: Cannot find name 'x'.`, 'Found 2 errors.'].join('\n'), root);
  assert.deepEqual(tsc.map((d) => [d.file, d.line, d.column, d.code]), [['src/a.ts', 12, 5, 'TS2322'], ['src/a.ts', 3, 1, 'TS2304']]);
  const ruff = parseDiagnostics('ruff', ['app/main.py:1:8: F401 `os` imported but unused', 'Found 1 error.'].join('\n'), root);
  assert.deepEqual(ruff.map((d) => [d.file, d.line, d.code]), [['app/main.py', 1, 'F401']]);
  const stylish = [path.join(root, 'src', 'b.js'), "  4:10  error  'x' is defined but never used  no-unused-vars", '  9:1  warning  Unexpected console statement  no-console', '', '✖ 2 problems (1 error, 1 warning)'].join('\n');
  assert.deepEqual(parseDiagnostics('eslint', stylish, root).map((d) => [d.file, d.line, d.severity, d.code]), [['src/b.js', 4, 'error', 'no-unused-vars'], ['src/b.js', 9, 'warning', 'no-console']]);
  const biome = ['src/c.ts:3:5 lint/suspicious/noDoubleEquals ━━━━━━━━━━', '', '  x Use === instead.'].join('\n');
  assert.deepEqual(parseDiagnostics('biome', biome, root).map((d) => [d.file, d.line, d.code]), [['src/c.ts', 3, 'lint/suspicious/noDoubleEquals']]);
  assert.deepEqual(parseDiagnostics('unknown', 'src/a.ts(1,1): error TS1: x', root), []);
  assert.equal(fixPrompt([]), '');
  assert.match(fixPrompt(tsc), /src\/a\.ts:12:5 \[TS2322\]/);

  console.log('PASS checks: detection, failure reporting, parsers, diagnostics route');
} finally {
  await rm(root, { recursive: true, force: true });
}
