import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths.ts';

export const IMAGE_TYPES: Readonly<Record<string, string>> = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' });
export const isDataId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/[^A-Za-z0-9_-]/.test(value);

export function requireDataId(id: string): string {
  const match = typeof id === 'string' ? /^[A-Za-z0-9_-]+$/.exec(id) : null;
  if (match?.[0] !== id) throw new Error('Invalid run or message ID');
  return id;
}

/** Private: callers perform operations, rather than passing raw paths to filesystem APIs. */
async function confinedPath(...segments: string[]): Promise<string> {
  const parts = segments.map((segment) => {
    const match = /^[A-Za-z0-9_.-]+$/.exec(segment);
    if (match?.[0] !== segment || segment === '.' || segment === '..') throw new Error('Invalid data path segment');
    return segment;
  });
  const root = await realpath(paths.dataDir);
  const target = path.resolve(root, ...parts);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Data path must stay inside the data directory');
  let existing = target;
  for (;;) {
    try { await lstat(existing); break; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      existing = path.dirname(existing);
    }
  }
  const resolved = path.relative(root, await realpath(existing));
  if (resolved === '..' || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) throw new Error('Data path must stay inside the data directory');
  return target;
}

export async function readRunFile(id: string): Promise<string> {
  const safeId = requireDataId(id);
  return readFile(await confinedPath(`${safeId}.json`), 'utf8');
}

let tempSequence = 0;
const retryableRenameErrors = new Set(['EPERM', 'EBUSY', 'EACCES']);

export async function writeRunFile(id: string, contents: string): Promise<void> {
  const safeId = requireDataId(id);
  const destination = await confinedPath(`${safeId}.json`);
  const temporary = await confinedPath(`${safeId}.${process.pid}.${++tempSequence}.tmp`);
  try {
    await writeFile(temporary, contents, 'utf8');
    for (let retry = 0; ; retry++) {
      try { await rename(temporary, destination); return; }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (!retryableRenameErrors.has(code ?? '') || retry === 5) throw err;
        await new Promise((resolve) => setTimeout(resolve, 50 * (retry + 1)));
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function removeRunFiles(id: string): Promise<void> {
  const safeId = requireDataId(id);
  // Validate both destinations before deletion so unsafe image links cannot partially delete a run.
  const runFile = await confinedPath(`${safeId}.json`);
  const images = await confinedPath('images', safeId);
  await rm(runFile);
  await rm(images, { recursive: true, force: true });
}

function imageFilename(index: number, mimeType: string, messageId?: string): string {
  if (!Number.isSafeInteger(index) || index < 0 || !Object.hasOwn(IMAGE_TYPES, mimeType)) throw new Error('Invalid image');
  const prefix = messageId === undefined ? '' : `${requireDataId(messageId)}-`;
  return `${prefix}${index}.${IMAGE_TYPES[mimeType]}`;
}

export async function readRunImage(id: string, index: number, mimeType: string, messageId?: string): Promise<Buffer<ArrayBuffer>> {
  const safeId = requireDataId(id);
  const name = imageFilename(index, mimeType, messageId);
  return readFile(await confinedPath('images', safeId, name));
}

export async function writeRunImages(id: string, images: { mimeType: string; bytes: Buffer }[], messageId?: string): Promise<void> {
  const safeId = requireDataId(id);
  if (images.length > 4) throw new Error('Choose up to 4 images');
  const names = images.map((image, index) => imageFilename(index, image.mimeType, messageId));
  const directory = await confinedPath('images', safeId);
  await mkdir(directory, { recursive: true });
  const results = await Promise.allSettled(images.map(async (image, index) => {
    const file = await confinedPath('images', safeId, names[index]);
    await writeFile(file, image.bytes);
  }));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    await Promise.all(names.map(async (name) => {
      try { await rm(await confinedPath('images', safeId, name), { force: true }); }
      catch { /* Cleanup is best effort; preserve the original write error. */ }
    }));
    throw failed.reason;
  }
}
