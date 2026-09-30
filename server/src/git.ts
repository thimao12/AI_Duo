import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!cwd || cwd.includes('\u0000')) throw new Error('Invalid Git working directory');
    const directory = realpathSync.native(path.resolve(cwd));
    if (!statSync(directory).isDirectory()) throw new Error('Git working directory must be a directory');
    execFile('git', args, { cwd: directory, shell: false, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

function treeId(value: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) throw new Error('Invalid Git tree ID');
  return value;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

/** Why Code cannot run in `cwd`, for every place that checks it (start, follow-up, Plan approval). */
export function gitRequiredMessage(cwd: string) {
  return `Code mode needs a git repository so changes can be diffed and reverted. "${cwd}" is not one (run \`git init\` there first).`;
}

/** Root of the working tree containing `cwd`, or null outside a repository. */
export async function gitToplevel(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim() || null;
  } catch {
    return null;
  }
}

/** Run `fn` with a throwaway index so the user's real staging area is never touched. */
async function withTempIndex<T>(cwd: string, fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-duo-idx-'));
  const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    return await fn(env);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Snapshot the whole working tree (tracked + untracked, respecting .gitignore) as a
 * git tree object. Pre-existing uncommitted changes become part of the baseline, so the
 * later diff only shows what the agents did.
 */
export function snapshotTree(cwd: string): Promise<string> {
  return withTempIndex(cwd, async (env) => {
    await git(cwd, ['read-tree', '--empty'], env);
    await git(cwd, ['add', '-A'], env);
    return treeId((await git(cwd, ['write-tree'], env)).trim());
  });
}

export interface TreeDiffSummary {
  stat: string;
  files: string[];
}

/** Summary of changes between two working-tree snapshots. */
export async function diffTreeSummary(cwd: string, before: string, after: string): Promise<TreeDiffSummary> {
  const beforeTree = treeId(before);
  const afterTree = treeId(after);
  const [stat, names] = await Promise.all([
    git(cwd, ['diff', '--no-color', '--no-renames', '--stat', beforeTree, afterTree, '--']),
    git(cwd, ['diff', '--no-color', '--no-renames', '--name-only', '-z', beforeTree, afterTree, '--']),
  ]);
  return { stat: stat.trim(), files: names.split('\0').filter(Boolean) };
}

/** Unified diff of the current working tree against a snapshot tree. */
export async function diffSince(cwd: string, baseTree: string): Promise<string> {
  const base = treeId(baseTree || EMPTY_TREE);
  const now = await snapshotTree(cwd);
  if (now === base) return '';
  return git(cwd, ['diff', '--no-color', '--find-renames', base, now, '--']);
}
