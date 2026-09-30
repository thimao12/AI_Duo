import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { authorizeDirectory, DirectoryAccessError } from '../project-directories.ts';

const MAX_ENTRIES = 2000;
const MAX_READ_BYTES = 512 * 1024;
const HIDDEN = new Set(['.git', 'node_modules']);

class PathError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 415) { super(message); }
}

/**
 * The ONLY place a request-supplied relative path becomes a filesystem path.
 * `root` is an already canonical directory (from authorizeDirectory). Containment proof: the
 * candidate is rejected when it is absolute or contains NUL, and the value returned is always
 * `root` joined with a relative path that path.relative(root, candidate) proved has no `..`
 * segment, so it cannot lie outside `root` lexically. When `follow` is set the result is
 * additionally realpath-ed and the same check is applied to the real location, so a symlink
 * whose target leaves the root is refused.
 */
async function confine(root: string, relative: string, follow: boolean): Promise<string> {
  if (typeof relative !== 'string' || relative.includes('\u0000') || path.isAbsolute(relative)) throw new PathError('Invalid path', 400);
  const inside = lexicalRelative(root, path.resolve(root, relative));
  const safe = path.join(root, inside);
  if (!follow) return safe;
  let real: string;
  try { real = await realpath(safe); }
  catch { throw new PathError('Not found', 404); }
  return path.join(root, lexicalRelative(root, real));
}

function lexicalRelative(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new PathError('Path escapes the project directory', 403);
  if (relative.split(path.sep).some((segment) => HIDDEN.has(segment))) throw new PathError('Path is not available', 403);
  return relative;
}

function param(value: string | undefined): string {
  return value ?? '';
}

function resolveRoot(cwd: string | undefined): string {
  if (!cwd) throw new PathError('cwd is required', 400);
  try { return authorizeDirectory(cwd); }
  catch (error) {
    if (error instanceof DirectoryAccessError) throw new PathError('Working directory not allowed', 403);
    throw error;
  }
}

async function listDirectory(root: string, relative: string) {
  const directory = await confine(root, relative, true);
  let dirents;
  try {
    if (!(await stat(directory)).isDirectory()) throw new PathError('Not a directory', 400);
    dirents = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof PathError) throw error;
    throw new PathError('Not found', 404);
  }
  const visible = dirents.filter((entry) => !HIDDEN.has(entry.name));
  // Symlinks are never followed here: they are listed as plain files.
  const entries = await Promise.all(visible.map(async (entry) => {
    if (!entry.isDirectory()) {
      const size = entry.isFile() ? await stat(path.join(directory, entry.name)).then((s) => s.size, () => undefined) : undefined;
      return { name: entry.name, type: 'file' as const, size };
    }
    return { name: entry.name, type: 'dir' as const };
  }));
  entries.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'dir' ? -1 : 1;
  });
  return { entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}

async function readTextFile(root: string, relative: string) {
  if (!relative) throw new PathError('path is required', 400);
  const file = await confine(root, relative, true);
  let handle;
  try { handle = await open(file, 'r'); }
  catch { throw new PathError('Not found', 404); }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new PathError('Not a file', 400);
    const buffer = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, bytesRead);
    if (data.includes(0)) throw new PathError('Binary files cannot be previewed', 415);
    return { path: relative, size: info.size, content: data.toString('utf8'), truncated: info.size > MAX_READ_BYTES };
  } finally {
    await handle.close();
  }
}

export function fileRoutes(): Hono {
  const app = new Hono();
  const guard = async <T>(c: { json: (body: unknown, status?: 400 | 403 | 404 | 415) => Response }, work: () => Promise<T>) => {
    try { return c.json(await work()); }
    catch (error) {
      if (error instanceof PathError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  };
  app.get('/api/files', (c) => guard(c, () => listDirectory(resolveRoot(c.req.query('cwd')), param(c.req.query('dir')))));
  app.get('/api/file', (c) => guard(c, () => readTextFile(resolveRoot(c.req.query('cwd')), param(c.req.query('path')))));
  return app;
}
