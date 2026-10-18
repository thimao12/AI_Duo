/**
 * Real Antigravity CLI check (calls a model and uses quota, so it is NOT part of `pnpm test`).
 *   pnpm --filter server test:antigravity-headless
 *
 * In a throwaway Git repository: a read turn (--mode plan) must return a result, end once stdin is closed
 * well within 60 s (headless agy never waits for an approval), and leave every file – tracked and
 * untracked – exactly as it was. Needs agy installed and signed in (AGY_BIN to pick a binary).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const LIMIT_MS = 60_000;
const temp = await mkdtemp(path.join(tmpdir(), 'ai duo agy headless '));
process.env.AI_DUO_SETTINGS_FILE = path.join(temp, 'settings.json');
process.env.AI_DUO_DATA_DIR = path.join(temp, 'runs');
const repo = path.join(temp, 'repo');
await mkdir(path.join(repo, 'src'), { recursive: true });

const { antigravity } = await import('./agents/antigravity.ts');
const { gitExecutable } = await import('./git.ts');

const git = (...args: string[]) => execFileSync(gitExecutable(), ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });

/** Every file under `dir` (except .git) with its contents. */
async function snapshot(dir: string, base = dir, out = new Map<string, string>()): Promise<Map<string, string>> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await snapshot(full, base, out);
    else out.set(path.relative(base, full), await readFile(full, 'utf8'));
  }
  return out;
}

try {
  const check = await antigravity.check(repo);
  if (check.error) {
    console.log(`SKIP antigravity headless: ${check.error}`);
    process.exit(0);
  }
  console.log(`agy ${check.version} at ${check.path} (login: ${check.auth})`);

  git('init', '-q');
  await writeFile(path.join(repo, 'README.md'), '# Demo\n\nThe answer is 42.\n', 'utf8');
  await writeFile(path.join(repo, 'src', 'add.js'), 'export const add = (a, b) => a + b;\n', 'utf8');
  git('add', '.');
  git('-c', 'user.name=ai-duo', '-c', 'user.email=ai-duo@example.invalid', 'commit', '-qm', 'init');
  await writeFile(path.join(repo, 'notes.txt'), 'untracked note\n', 'utf8');
  const before = await snapshot(repo);
  const statusBefore = git('status', '--porcelain');

  const started = Date.now();
  const result = await antigravity.run({
    prompt: 'Read README.md and src/add.js. Reply with the number stated in README.md and the name of the exported function. Do not edit, create or delete any file and do not run commands.',
    cwd: repo,
    role: 'thinker',
    permission: 'read',
    signal: new AbortController().signal,
    timeoutMs: LIMIT_MS,
    allowUnverifiedAuth: true,
    onEvent: (e) => {
      if (e.kind === 'tool' || e.kind === 'error') console.log(`  ${e.kind}: ${e.content.slice(0, 200)}`);
    },
  });
  const took = Date.now() - started;

  assert.ok(result.finalText.trim(), 'a read turn returns a result');
  assert.ok(took < LIMIT_MS, `ended in ${took} ms`);
  assert.ok(result.sessionId, 'a conversation id to continue from');
  assert.deepEqual(await snapshot(repo), before, 'tracked and untracked files unchanged');
  assert.equal(git('status', '--porcelain'), statusBefore, 'git status unchanged');
  console.log(`reply (${took} ms): ${result.finalText.slice(0, 300)}`);
  console.log('PASS antigravity headless: --mode plan returns a result, ends on EOF, changes no file');
} finally {
  await rm(temp, { recursive: true, force: true }).catch(() => {});
}
process.exit(0);
