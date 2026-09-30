import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { gitRepositoryId } from './git.ts';
import { paths } from './paths.ts';
import { authorizeDirectory } from './project-directories.ts';

/**
 * One Code or Plan run per repository, across every AI Duo process (web, desktop, CLI).
 *
 * The lock is a JSON file in <data dir>/locks named after a hash of the canonical Git toplevel
 * (the canonical folder itself outside a repository, which only Plan allows). It is created
 * atomically: the full contents are written to a temp file first and then hard-linked into place,
 * which fails if the lock already exists, so a reader never sees a half-written owner.
 *
 * A lock is never removed because it looks old. When its process dies, `ai-duo unlock` removes
 * it after checking that the owner PID is no longer running on this machine.
 */

export interface LockOwner {
  version: 1;
  /** Random per acquisition; release only deletes a lock that still carries this token. */
  token: string;
  pid: number;
  hostname: string;
  runId: string;
  /** Canonical repository root (or working folder) the lock covers. */
  root: string;
  /** Which front end holds it: cli, server or desktop. */
  app: string;
  createdAt: number;
}

export interface LockTarget {
  root: string;
  file: string;
  /** False when the folder is not inside a Git repository (Plan only). */
  git: boolean;
}

/** alive / dead on this machine; unknown when the owner is on another host or unreadable. */
export type OwnerState = 'alive' | 'dead' | 'unknown';

export const locksDir = () => path.join(paths.dataDir, 'locks');

/** Two paths into the same repository (case variants, symlinks, subfolders) map to one lock. */
export async function lockTarget(cwd: string): Promise<LockTarget> {
  const directory = authorizeDirectory(cwd);
  const top = await gitRepositoryId(directory);
  // Git reports its root from the canonical cwd. This identity also keeps restricted Plan
  // folders on the same lock as another app that can run Code in the whole repository.
  const root = top ?? directory;
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return { root, file: path.join(locksDir(), `${hash}.lock`), git: top !== null };
}

/** undefined = no lock file; null = a lock file that cannot be read as an owner. */
export async function readLockOwner(file: string): Promise<LockOwner | null | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
  }
  try {
    const owner = JSON.parse(text);
    return owner && typeof owner.token === 'string' && Number.isSafeInteger(owner.pid) ? owner : null;
  } catch {
    return null;
  }
}

export function ownerState(owner: LockOwner | null | undefined): OwnerState {
  if (!owner || owner.hostname !== hostname()) return 'unknown';
  try {
    process.kill(owner.pid, 0);
    return 'alive';
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'alive' : 'dead';
  }
}

export function describeOwner(owner: LockOwner) {
  return `run ${owner.runId} (${owner.app}, PID ${owner.pid} on ${owner.hostname}, since ${new Date(owner.createdAt).toLocaleString()})`;
}

export class RepoLockedError extends Error {
  constructor(
    readonly target: LockTarget,
    readonly owner: LockOwner | null,
    readonly state: OwnerState,
  ) {
    const who = owner ? `: ${describeOwner(owner)}` : ' (the lock file is unreadable)';
    const unlock = `ai-duo unlock "${target.root}"`;
    let hint = '';
    if (state === 'dead') {
      hint = `\nThat process is no longer running. Once no agent is still editing the repository, run \`${unlock}\` (or delete ${target.file}).`;
    } else if (state === 'unknown') {
      hint = `\nThe owner cannot be checked from here. If you are sure it has stopped, run \`${unlock} --force\` (or delete ${target.file}).`;
    }
    super(`A Code or Plan run is already active for this repository (${target.root})${who}${hint}`);
  }
}

export interface RepoLock {
  target: LockTarget;
  owner: LockOwner;
  release(): Promise<void>;
}

async function removeIfOwned(file: string, token: string, retry = 0): Promise<void> {
  const current = await readLockOwner(file);
  if (current?.token !== token) return;
  try {
    await rm(file, { force: true });
  } catch (err) {
    // Windows refuses to delete a file another process is reading right now.
    if (retry === 5) throw err;
    await new Promise((resolve) => setTimeout(resolve, 50 * (retry + 1)));
    await removeIfOwned(file, token, retry + 1);
  }
}

/** True when the lock file was created; false when another run already holds it. */
async function createLockFile(tmp: string, file: string, contents: string): Promise<boolean> {
  try {
    await link(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    // File systems without hard links: exclusive create is still atomic, just not all-or-nothing.
    try {
      await writeFile(file, contents, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (error_) {
      if ((error_ as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return false;
    }
  }
}

async function claimLockFile(target: LockTarget, tmp: string, contents: string, attempt = 0): Promise<void> {
  if (await createLockFile(tmp, target.file, contents)) return;
  const existing = await readLockOwner(target.file);
  // Released between our attempt and the read: try again.
  if (existing === undefined && attempt < 3) return claimLockFile(target, tmp, contents, attempt + 1);
  throw new RepoLockedError(target, existing ?? null, ownerState(existing));
}

/** Throws RepoLockedError when another run (in any process) holds the repository. */
export async function acquireRepoLock(target: LockTarget, runId: string, app: string): Promise<RepoLock> {
  const owner: LockOwner = { version: 1, token: randomUUID(), pid: process.pid, hostname: hostname(), runId, root: target.root, app, createdAt: Date.now() };
  const contents = `${JSON.stringify(owner, null, 2)}\n`;
  await mkdir(path.dirname(target.file), { recursive: true });
  const tmp = `${target.file}.${process.pid}.${owner.token}.tmp`;
  await writeFile(tmp, contents, 'utf8');
  try {
    await claimLockFile(target, tmp, contents);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }

  let released = false;
  return {
    target,
    owner,
    release: async () => {
      if (released) return;
      released = true;
      await removeIfOwned(target.file, owner.token);
    },
  };
}

export interface LockInfo {
  file: string;
  owner: LockOwner | null;
  state: OwnerState;
}

export async function listLocks(): Promise<LockInfo[]> {
  const names = (await readdir(locksDir()).catch(() => [] as string[])).filter((name) => name.endsWith('.lock'));
  const infos = await Promise.all(names.map(async (name) => {
    const file = path.join(locksDir(), name);
    return { file, owner: await readLockOwner(file) };
  }));
  return infos.flatMap(({ file, owner }) => (owner === undefined ? [] : [{ file, owner, state: ownerState(owner) }]));
}

/**
 * Runs that another AI Duo process (CLI, desktop, another server) is running right now. Runs of
 * this process are tracked in memory instead, so its own locks are left out.
 */
export async function runsActiveElsewhere(): Promise<Map<string, LockOwner>> {
  const out = new Map<string, LockOwner>();
  for (const lock of await listLocks()) {
    if (!lock.owner || lock.state === 'dead') continue;
    if (lock.owner.pid === process.pid && lock.owner.hostname === hostname()) continue;
    out.set(lock.owner.runId, lock.owner);
  }
  return out;
}

export type UnlockResult =
  | { result: 'none'; target: LockTarget }
  | { result: 'released' | 'refused'; target: LockTarget; owner: LockOwner | null; state: OwnerState };

/**
 * Remove a lock left behind by a process that died. A live owner, an owner on another machine or
 * an unreadable lock file is only removed with `force`.
 */
export async function unlockRepo(cwd: string, { force = false } = {}): Promise<UnlockResult> {
  const target = await lockTarget(cwd);
  const owner = await readLockOwner(target.file);
  if (owner === undefined) return { result: 'none', target };
  const state = ownerState(owner);
  if (state !== 'dead' && !force) return { result: 'refused', target, owner, state };
  if (owner) await removeIfOwned(target.file, owner.token);
  else await rm(target.file, { force: true });
  return { result: 'released', target, owner, state };
}
