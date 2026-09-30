import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = await mkdtemp(path.join(tmpdir(), 'ai duo files '));
const project = path.join(temp, 'project');
const outside = path.join(temp, 'outside');
await mkdir(project, { recursive: true });
await Promise.all([mkdir(path.join(project, 'src')), mkdir(path.join(project, '.git')), mkdir(path.join(project, 'node_modules')), mkdir(outside)]);
await Promise.all([
  writeFile(path.join(project, 'src', 'a.txt'), 'hello'),
  writeFile(path.join(project, 'readme.md'), '# hi'),
  writeFile(path.join(project, 'bin.dat'), Buffer.from([1, 2, 0, 3])),
  writeFile(path.join(project, '.git', 'config'), 'x'),
  writeFile(path.join(outside, 'secret.txt'), 'secret'),
]);
process.env.AI_DUO_ALLOWED_ROOTS = JSON.stringify([project]);

const { fileRoutes } = await import('./routes/files.ts');
const app = fileRoutes();
const get = (route: string, params: Record<string, string>) => app.request(`${route}?${new URLSearchParams(params)}`);
const status = async (route: string, params: Record<string, string>) => (await get(route, params)).status;

try {
  const list = await get('/api/files', { cwd: project });
  assert.equal(list.status, 200);
  const body = await list.json() as { entries: { name: string; type: string; size?: number }[]; truncated: boolean };
  assert.deepEqual(body.entries.map((e) => e.name), ['src', 'bin.dat', 'readme.md']);
  assert.equal(body.entries[0]?.type, 'dir');
  assert.equal(body.truncated, false);

  const sub = await (await get('/api/files', { cwd: project, dir: 'src' })).json() as { entries: { name: string }[] };
  assert.deepEqual(sub.entries.map((e) => e.name), ['a.txt']);

  const rel = path.join('src', 'a.txt');
  const read = await get('/api/file', { cwd: project, path: rel });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { path: rel, size: 5, content: 'hello', truncated: false });

  assert.equal(await status('/api/file', { cwd: project, path: path.join('..', 'outside', 'secret.txt') }), 403);
  assert.equal(await status('/api/files', { cwd: project, dir: '..' }), 403);
  assert.equal(await status('/api/file', { cwd: project, path: path.join(outside, 'secret.txt') }), 400);
  assert.equal(await status('/api/file', { cwd: project, path: 'readme.md\u0000.png' }), 400);
  assert.equal(await status('/api/file', { cwd: project, path: 'bin.dat' }), 415);
  assert.equal(await status('/api/file', { cwd: project, path: 'missing.txt' }), 404);
  assert.equal(await status('/api/files', { cwd: outside }), 403);
  assert.equal(await status('/api/files', { cwd: temp }), 403);
  assert.equal(await status('/api/files', {}), 400);

  try {
    await symlink(outside, path.join(project, 'link-dir'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(path.join(outside, 'secret.txt'), path.join(project, 'link-file'), 'file');
    assert.equal(await status('/api/file', { cwd: project, path: 'link-file' }), 403);
    assert.equal(await status('/api/file', { cwd: project, path: path.join('link-dir', 'secret.txt') }), 403);
    assert.equal(await status('/api/files', { cwd: project, dir: 'link-dir' }), 403);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    console.log('symlink cases skipped (no privilege)');
  }
  console.log('files smoke ok');
} finally {
  await rm(temp, { recursive: true, force: true });
}
