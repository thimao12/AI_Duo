import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findExecutable } from '../../shared/exe.ts';
import { authorizeDirectory, DirectoryAccessError, projectDirectories } from './project-directories.ts';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Git binary from the absolute PATH entries; falls back to the bare name only when it is not found. */
export function gitExecutable(): string {
  return findExecutable('git') ?? 'git';
}

/** Authorized working directory, re-verified against the allowed roots right before it reaches a child process. */
function confineDirectory(cwd: string): string {
  const directory = path.resolve(authorizeDirectory(cwd));
  for (const root of projectDirectories().canonicalRoots()) {
    const relative = path.relative(root, directory);
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return path.join(root, relative);
  }
  throw new DirectoryAccessError(`Working directory is outside AI_DUO_ALLOWED_ROOTS: ${directory}`);
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const directory = confineDirectory(cwd);
    execFile(gitExecutable(), args, { cwd: directory, shell: false, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
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
  return (await gitToplevel(cwd)) !== null;
}

/** Why Code cannot run in `cwd`, for every place that checks it (start, follow-up, Plan approval). */
export function gitRequiredMessage(cwd: string) {
  return `Code mode needs a git repository so changes can be diffed and reverted. "${cwd}" has no allowed repository (run \`git init\` there if needed, or add its Git root to AI_DUO_ALLOWED_ROOTS).`;
}

/** Root of the working tree containing `cwd`, or null outside a repository. */
export async function gitToplevel(cwd: string): Promise<string | null> {
  const root = await gitRepositoryId(cwd);
  try { return root ? authorizeDirectory(root) : null; }
  catch { return null; }
}

/** Repository identity for shared locks; outside roots may identify a lock, never a filesystem operation. */
export async function gitRepositoryId(cwd: string): Promise<string | null> {
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    return root && path.isAbsolute(root) ? path.resolve(root) : null;
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
export async function snapshotTree(cwd: string): Promise<string> {
  const root = await gitToplevel(cwd);
  if (!root) throw new Error('Snapshot requires a Git repository inside AI_DUO_ALLOWED_ROOTS');
  return withTempIndex(root, async (env) => {
    await git(root, ['read-tree', '--empty'], env);
    await git(root, ['add', '-A'], env);
    return treeId((await git(root, ['write-tree'], env)).trim());
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
  const root = await gitToplevel(cwd);
  if (!root) throw new Error('Diff requires a Git repository inside AI_DUO_ALLOWED_ROOTS');
  const [stat, names] = await Promise.all([
    git(root, ['diff', '--no-color', '--no-renames', '--stat', beforeTree, afterTree, '--']),
    git(root, ['diff', '--no-color', '--no-renames', '--name-only', '-z', beforeTree, afterTree, '--']),
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
