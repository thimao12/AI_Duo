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

  // Commit: only the files the run changed, with other staged and unstaged work left alone.
  const { changedFiles, commitFiles } = await import('./git.ts');
  await write('a.txt', 'one\ntwo\nthree\n');
  await write('other.txt', 'staged by me\n');
  git('add', 'other.txt');
  await write('mine.txt', 'unstaged edit\n');
  const before = await snapshotTree(repo);
  await write('a.txt', 'one\nAGENT\nthree\n');
  await write('made.txt', 'new\n');
  const done = await snapshotTree(repo);
  const touched = await changedFiles(repo, before, done);
  assert.deepEqual(touched.sort(), ['a.txt', 'made.txt']);
  const made = await commitFiles(repo, touched, 'AI Duo: edit a and add made');
  assert.deepEqual(made.files.sort(), ['a.txt', 'made.txt']);
  assert.match(made.commit, /^[0-9a-f]{7,}$/);
  assert.equal(git('log', '-1', '--format=%s').trim(), 'AI Duo: edit a and add made');
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['a.txt', 'made.txt']);
  assert.match(git('status', '--short'), /A\s+other\.txt/, 'work I had staged is still staged, not committed');
  assert.match(git('status', '--short'), /M\s+mine\.txt/, 'unstaged work is untouched');
  await assert.rejects(commitFiles(repo, touched, 'again'), /không có thay đổi/);
  await assert.rejects(commitFiles(repo, [], 'x'), /Không có file/);
  await assert.rejects(commitFiles(repo, touched, '  '), /nội dung commit/);

  await assert.rejects(undoSince(repo, 'not-a-tree', after), /Invalid Git tree ID/);
  await assert.rejects(undoSince(temp, base, after), /Git repository/);

  // Service level: unknown run, a run without checkpoints, then commit and undo of saved runs.
  const { RunService, ServiceError } = await import('./service.ts');
  const { saveRun } = await import('./store.ts');
  const service = new RunService({ app: 'cli' });
  await assert.rejects(service.undo('missing'), (e) => e instanceof ServiceError && e.code === 'not_found');
  await assert.rejects(service.commit('missing'), (e) => e instanceof ServiceError && e.code === 'not_found');

  const savedRun = async (id: string, trees?: { baseTree: string; afterTree: string }) => {
    await saveRun({
      id,
      title: 'Fix the footer',
      config: { mode: 'code', prompt: 'Fix the footer\nplease', cwd: repo, maxRounds: 2, judge: 'claude', coder: 'claude', turnTimeoutMin: 30 },
      status: 'done',
      createdAt: Date.now(),
      messages: [],
      ...trees,
    });
  };
  await savedRun('plain-run');
  await assert.rejects(service.undo('plain-run'), /không có điểm khôi phục/);
  await assert.rejects(service.commit('plain-run'), /không có thay đổi file/);

  await write('a.txt', 'one\ntwo\nthree\n');
  await write('made.txt', '');
  git('add', '-A');
  git('commit', '-qm', 'clean slate');
  const start = await snapshotTree(repo);
  await write('a.txt', 'one\nSERVICE\nthree\n');
  await write('svc.txt', 'new\n');
  const end = await snapshotTree(repo);
  await savedRun('commit-run', { baseTree: start, afterTree: end });
  assert.equal(await service.commitMessage('commit-run'), 'Fix the footer');
  const committed = await service.commit('commit-run');
  assert.deepEqual([committed.message, committed.files.sort()], ['Fix the footer', ['a.txt', 'svc.txt']]);
  assert.equal((await service.get('commit-run'))?.commit, committed.commit, 'the commit is remembered on the run');
  await assert.rejects(service.commit('commit-run'), /đã được commit/);

  await write('a.txt', 'one\nSERVICE2\nthree\n');
  const start2 = await snapshotTree(repo);
  await write('a.txt', 'one\nAGAIN\nthree\n');
  await savedRun('undo-run', { baseTree: start2, afterTree: await snapshotTree(repo) });
  const undone = await service.undo('undo-run');
  assert.deepEqual(undone, { files: ['a.txt'], reverted: true });
  assert.equal(await read('a.txt'), 'one\nSERVICE2\nthree\n');
  assert.ok((await service.get('undo-run'))?.undoneAt);
  await assert.rejects(service.undo('undo-run'), /đã được hoàn tác/);
  await assert.rejects(service.commit('undo-run'), /đã được hoàn tác/);

  console.log('PASS undo: edit, create, delete, binary, kept work, commit, repeat, conflict, service');
} finally {
  await rm(temp, { recursive: true, force: true });
}
