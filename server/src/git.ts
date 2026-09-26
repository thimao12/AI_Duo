import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

/** Run `fn` with a throwaway index so the user's real staging area is never touched. */
async function withTempIndex<T>(cwd: string, fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-duo-idx-'));
  const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    return await fn(env);
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
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
    return (await git(cwd, ['write-tree'], env)).trim();
  });
}

/** Unified diff of the current working tree against a snapshot tree. */
export async function diffSince(cwd: string, baseTree: string): Promise<string> {
  const now = await snapshotTree(cwd);
  if (now === baseTree) return '';
  return git(cwd, ['diff', '--no-color', '--find-renames', baseTree || EMPTY_TREE, now]);
}
