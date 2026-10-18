/**
 * Smoke test for Undo: the agents' changes are taken back from a real repository, untouched files
 * and staged work survive, and later edits of the same lines are refused.
 *   pnpm --filter server test:undo
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = await mkdtemp(path.join(tmpdir(), 'ai duo undo smoke '));
process.env.AI_DUO_ALLOWED_ROOTS = JSON.stringify([temp]);
process.env.AI_DUO_DATA_DIR = path.join(temp, 'data');
process.env.AI_DUO_SETTINGS_FILE = path.join(temp, 'settings.json');
const repo = path.join(temp, 'repo');
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
// core.autocrlf (default on Windows) may turn LF into CRLF when Git writes a file back.
const read = async (file: string) => (await readFile(path.join(repo, file), 'utf8')).replaceAll('\r\n', '\n');
const write = (file: string, text: string) => writeFile(path.join(repo, file), text);

try {
  const { snapshotTree, undoSince } = await import('./git.ts');
  await mkdir(repo);
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  await write('a.txt', 'one\ntwo\nthree\n');
  await write('gone.txt', 'delete me\n');
  await write('mine.txt', 'mine\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  await write('mine.txt', 'mine, uncommitted\n');

  const base = await snapshotTree(repo);
  assert.deepEqual(await undoSince(repo, base, base), { status: 'nothing' }, 'nothing changed yet');

  // What an agent does: edit, create (also in a new folder), delete, add a binary file.
  await write('a.txt', 'one\nTWO\nthree\nfour\n');
  await mkdir(path.join(repo, 'src'));
  await write('src/new.ts', 'export {};\n');
  await rm(path.join(repo, 'gone.txt'));
  await writeFile(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 255, 0]));
  const after = await snapshotTree(repo);

  const result = await undoSince(repo, base, after);
  assert.equal(result.status, 'reverted');
  assert.deepEqual((result as { files: string[] }).files.sort(), ['a.txt', 'bin.dat', 'gone.txt', 'src/new.ts']);
  assert.equal(await read('a.txt'), 'one\ntwo\nthree\n');
  assert.equal(await read('gone.txt'), 'delete me\n');
  assert.equal(await read('mine.txt'), 'mine, uncommitted\n', 'work that existed before the run is kept');
  assert.equal(existsSync(path.join(repo, 'src', 'new.ts')), false);
  assert.equal(existsSync(path.join(repo, 'bin.dat')), false);
  assert.equal(git('log', '--oneline').trim().split('\n').length, 1, 'no commit was made');
  assert.deepEqual(await undoSince(repo, base, await snapshotTree(repo)), { status: 'nothing' }, 'undo twice is a no-op');

  // The user edits the same lines after the run: refuse and change nothing.
  await write('a.txt', 'one\ntwo\nthree\n');
  const base2 = await snapshotTree(repo);
  await write('a.txt', 'one\nAGENT\nthree\n');
  const after2 = await snapshotTree(repo);
  await write('a.txt', 'one\nUSER\nthree\n');
  await assert.rejects(undoSince(repo, base2, after2), /Không thể hoàn tác/);
  assert.equal(await read('a.txt'), 'one\nUSER\nthree\n', 'a refused undo touches nothing');

  // Later work on a file the agent did not touch is not part of the patch.
  await write('a.txt', 'one\nAGENT\nthree\n');
  await write('mine.txt', 'edited later\n');
  assert.equal((await undoSince(repo, base2, after2)).status, 'reverted');
  assert.equal(await read('a.txt'), 'one\ntwo\nthree\n');
  assert.equal(await read('mine.txt'), 'edited later\n', 'later work on other files is kept');

  await assert.rejects(undoSince(repo, 'not-a-tree', after), /Invalid Git tree ID/);
  await assert.rejects(undoSince(temp, base, after), /Git repository/);

  // Service level: unknown run.
  const { RunService, ServiceError } = await import('./service.ts');
  const service = new RunService({ app: 'cli' });
  await assert.rejects(service.undo('missing'), (e) => e instanceof ServiceError && e.code === 'not_found');

  console.log('PASS undo: edit, create, delete, binary, kept work, repeat, conflict, service errors');
} finally {
  await rm(temp, { recursive: true, force: true });
}
