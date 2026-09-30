import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Run } from './types.ts';

const temp = await mkdtemp(path.join(tmpdir(), 'ai duo path smoke '));
const dataDir = path.join(temp, 'runs');
const outside = path.join(temp, 'outside');
process.env.AI_DUO_DATA_DIR = dataDir;
process.env.AI_DUO_ALLOWED_ROOTS = JSON.stringify([temp]);
await mkdir(outside);

try {
  const [{ readRunImage, writeRunImages }, { saveRun, loadRun, deleteRun }, { startServer }, git] = await Promise.all([
    import('./data-path.ts'), import('./store.ts'), import('./app.ts'), import('./git.ts'),
  ]);
  const run: Run = {
    id: 'safe-run', status: 'done', createdAt: Date.now(),
    config: { mode: 'plan', prompt: 'path smoke', cwd: temp, maxRounds: 2, judge: 'claude', coder: 'codex', turnTimeoutMin: 30, images: [{ name: 'initial.png', mimeType: 'image/png' }] },
    messages: [{ id: 'message-1', agent: 'user', phase: 'info', round: 0, title: 'Follow-up', parts: [], status: 'done', startedAt: Date.now(), images: [{ name: 'follow-up.png', mimeType: 'image/png' }] }],
  };
  await saveRun(run);
  const sentinel = path.join(outside, 'keep.txt');
  await writeFile(sentinel, 'outside untouched');
  const invalidIds = ['../outside', String.raw`..\outside`, '/absolute', String.raw`C:\absolute`, '%2e%2e', 'a/b', String.raw`a\b`, '.', '..', 'a\u0000b', 'a\n'];
  await Promise.all(invalidIds.map(async (id) => {
    assert.equal(await loadRun(id), undefined, id);
    assert.equal(await deleteRun(id), false, id);
    await assert.rejects(saveRun({ ...run, id }), /Invalid.*ID/, id);
    await assert.rejects(writeRunImages(id, [{ mimeType: 'image/png', bytes: Buffer.from('bad') }]), /Invalid.*ID/, id);
  }));
  assert.deepEqual((await readdir(dataDir)).filter((name) => name.endsWith('.tmp')), []);
  const images = path.join(dataDir, 'images', run.id);
  await writeRunImages(run.id, [{ mimeType: 'image/png', bytes: Buffer.from('initial image') }]);
  await writeRunImages(run.id, [{ mimeType: 'image/png', bytes: Buffer.from('follow-up image') }], 'message-1');
  await assert.rejects(readRunImage(run.id, 0, 'constructor'), /Invalid image/);
  await assert.rejects(readRunImage(run.id, 0.5, 'image/png'), /Invalid image/);
  await assert.rejects(readRunImage(run.id, 0, 'image/png', '../outside'), /Invalid.*ID/);
  const server = await startServer({ port: 0 });
  try {
    const initial = await fetch(`${server.url}/api/runs/${run.id}/images/0`);
    assert.equal(initial.status, 200);
    assert.equal(await initial.text(), 'initial image');
    const followUp = await fetch(`${server.url}/api/runs/${run.id}/messages/message-1/images/0`);
    assert.equal(followUp.status, 200);
    assert.equal(await followUp.text(), 'follow-up image');
    const badRoutes = [
      '/api/runs/a%2Fb/images/0', '/api/runs/a%5Cb/images/0', '/api/runs/%252e%252e/images/0',
      '/api/runs/safe-run/messages/a%2Fb/images/0', '/api/runs/safe-run/messages/a%5Cb/images/0',
      '/api/runs/safe-run/images/-1', '/api/runs/safe-run/images/1.5', '/api/runs/safe-run/images/Infinity',
    ];
    await Promise.all(badRoutes.map(async (route) => assert.equal((await fetch(`${server.url}${route}`)).status, 404, route)));

    // A junction works without symlink privileges on Windows and exercises directory traversal.
    await rm(images, { recursive: true });
    await writeFile(path.join(outside, '0.png'), 'private outside image');
    await symlink(outside, images, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await fetch(`${server.url}/api/runs/${run.id}/images/0`)).status, 404);
    await assert.rejects(deleteRun(run.id), /Data path must stay/);
    assert.equal((await loadRun(run.id))?.id, run.id, 'unsafe deletion must not partially remove the run');
    await assert.rejects(writeRunImages(run.id, [{ mimeType: 'image/png', bytes: Buffer.from('new') }]), /Data path must stay/);
    await rm(images);
  } finally {
    await server.close();
  }
  assert.equal(await readFile(sentinel, 'utf8'), 'outside untouched');
  assert.equal(await readFile(path.join(outside, '0.png'), 'utf8'), 'private outside image');
  assert.equal(await deleteRun(run.id), true);

  const repo = path.join(temp, 'repo with spaces');
  await mkdir(repo);
  execFileSync(git.gitExecutable(), ['init', '-q'], { cwd: repo });
  await writeFile(path.join(repo, 'baseline.txt'), 'before');
  const before = await git.snapshotTree(repo);
  await writeFile(path.join(repo, 'baseline.txt'), 'after');
  const after = await git.snapshotTree(repo);
  assert.deepEqual((await git.diffTreeSummary(repo, before, after)).files, ['baseline.txt']);
  assert.match(await git.diffSince(repo, before), /baseline\.txt/);
  await Promise.all(['--output=outside', '../outside', 'HEAD', 'a'.repeat(39), 'z'.repeat(40), 'a'.repeat(65)].map(async (invalid) => {
    await assert.rejects(git.diffTreeSummary(repo, invalid, after), /Invalid Git tree ID/);
    await assert.rejects(git.diffSince(repo, invalid), /Invalid Git tree ID/);
  }));
  assert.equal(await git.isGitRepo(path.join(repo, 'baseline.txt')), false);
  assert.equal(await git.isGitRepo(`${repo}\u0000`), false);
  assert.equal(await git.isGitRepo(repo), true);
  console.log('PASS confined data paths, image routes, symlink protection and Git arguments');
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
