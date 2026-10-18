import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('a failed build preserves the linked CLI and its prompts', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'ai-duo-build-'));
  try {
    const cli = path.join(temp, 'cli');
    const dist = path.join(cli, 'dist');
    await mkdir(path.join(dist, 'prompts'), { recursive: true });
    await writeFile(path.join(dist, 'ai-duo.mjs'), 'previous working CLI');
    await writeFile(path.join(dist, 'prompts', 'fix.md'), 'previous prompt');
    const source = await readFile(new URL('./build.mjs', import.meta.url), 'utf8');
    await writeFile(path.join(cli, 'build.mjs'), source.replace("'esbuild'", JSON.stringify(import.meta.resolve('esbuild'))));
    // No src/main.ts: compilation must fail without destroying the previous install.
    const result = spawnSync(process.execPath, [path.join(cli, 'build.mjs')], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Build failed/);
    assert.equal(await readFile(path.join(dist, 'ai-duo.mjs'), 'utf8'), 'previous working CLI');
    assert.equal(await readFile(path.join(dist, 'prompts', 'fix.md'), 'utf8'), 'previous prompt');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
