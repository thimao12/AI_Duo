import { diffSince, isGitRepo, snapshotTree } from '../git.ts';
import type { RunContext } from '../run.ts';

const MAX_DIFF_CHARS = 60_000;

/** A diff as a fenced block for a prompt, cut at a size the model can read. */
export function formatDiff(diff: string) {
  if (!diff.trim()) return '_(no changes detected)_';
  const cut = diff.length > MAX_DIFF_CHARS;
  return '```diff\n' + (cut ? diff.slice(0, MAX_DIFF_CHARS) : diff) + '\n```' + (cut ? '\n(diff truncated – inspect the files directly for the rest)' : '');
}

/**
 * Runs `work` and records what it changed in the repository as the run's diff, with the Git trees before
 * and after (what Undo and /commit use). Only when edits are possible and the folder is a repository;
 * `work` gets the starting tree. The record is made even when `work` fails or is cancelled, since the
 * agents may already have written files.
 */
export async function trackChanges(ctx: RunContext, edits: boolean, work: (base: string | undefined) => Promise<void>): Promise<void> {
  const { cwd } = ctx.run.config;
  const base = edits && (await isGitRepo(cwd)) ? await snapshotTree(cwd) : undefined;
  if (base) ctx.update({ baseTree: base });
  try {
    await work(base);
  } finally {
    if (base) {
      try {
        ctx.update({ diff: await diffSince(cwd, base), afterTree: await snapshotTree(cwd) });
      } catch (err) {
        console.error(`Could not record the changes of run ${ctx.run.id}:`, (err as Error).message);
      }
    }
  }
}
