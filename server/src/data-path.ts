import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths.ts';

export const isDataId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]+$/.test(value);

function assertWithin(root: string, target: string) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Data path must stay inside the data directory');
  }
}

/** Validate both the lexical path and existing symlinks before any data-file operation. */
export async function dataPath(...segments: string[]): Promise<string> {
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || !/^[\w.-]+$/.test(segment)) throw new Error('Invalid data path segment');
  }
  const root = path.resolve(paths.dataDir);
  const target = path.resolve(root, ...segments);
  assertWithin(root, target);
  const canonicalRoot = await realpath(root);
  let existing = target;
  for (;;) {
    try {
      await lstat(existing);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      existing = path.dirname(existing);
    }
  }
  assertWithin(canonicalRoot, await realpath(existing));
  return target;
}

export function requireDataId(id: string): string {
  if (!isDataId(id)) throw new Error('Invalid run or message ID');
  return id;
}
