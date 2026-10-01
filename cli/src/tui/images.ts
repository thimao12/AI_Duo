import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** Same limits as the server (parseImages) and the web composer. */
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** One image waiting in the composer for the next message. */
export interface ImageAttachment {
  /** File name sent to the server (the pasted file's name, or clipboard.png). */
  name: string;
  mime: ImageMime;
  bytes: number;
  dataUrl: string;
  source: 'clipboard' | 'file';
}

export type LoadResult = { ok: true; image: ImageAttachment } | { ok: false; error: string };

const SHORT_TYPE: Record<ImageMime, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/gif': 'GIF' };

export const LIMIT_NOTE = `You can attach up to ${MAX_IMAGES} images. Delete one of the [Image #N] tokens, or use /clear-images, first.`;

/** The image type from the file's first bytes (never from its extension), or undefined. */
export function sniffImage(bytes: Uint8Array): ImageMime | undefined {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (head.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const shortType = (mime: ImageMime): string => SHORT_TYPE[mime];

/** The images as a RunRequest field. */
export const toRequestImages = (images: readonly ImageAttachment[]): { name: string; dataUrl: string }[] => images.map(({ name, dataUrl }) => ({ name, dataUrl }));

/** Checks size and magic bytes; builds the attachment. */
export function attachmentFromBytes(bytes: Buffer, name: string, source: ImageAttachment['source']): LoadResult {
  if (bytes.length === 0) return { ok: false, error: `"${name}" is empty.` };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: `"${name}" is larger than 5 MB.` };
  const mime = sniffImage(bytes);
  if (!mime) return { ok: false, error: `"${name}" is not a PNG, JPEG, WebP or GIF image.` };
  return { ok: true, image: { name, mime, bytes: bytes.length, dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, source } };
}

/**
 * Reads one image file the user named. undefined = nothing to attach (missing, not a regular file):
 * the caller treats the text as plain text. The path is resolved with realpath, checked with stat
 * (regular file, at most 5 MB) and read once; the type comes from the magic bytes.
 */
export async function loadImageFile(file: string): Promise<LoadResult | undefined> {
  let real: string;
  let size: number;
  try {
    real = await realpath(file);
    const info = await stat(real);
    if (!info.isFile()) return undefined;
    size = info.size;
  } catch {
    return undefined;
  }
  const name = path.basename(file);
  if (size > MAX_IMAGE_BYTES) return { ok: false, error: `"${name}" is larger than 5 MB.` };
  try {
    return attachmentFromBytes(await readFile(real), name, 'file');
  } catch {
    return { ok: false, error: `Could not read "${name}".` };
  }
}

const BACKSLASH = String.fromCodePoint(92);
const IMAGE_EXT = /\.(?:png|jpe?g|webp|gif)$/i;

export interface PathEnv {
  cwd: string;
  home?: string;
  platform?: NodeJS.Platform;
}

function unquote(text: string): string {
  const first = text[0];
  if ((first === '"' || first === "'") && text.length >= 2 && text.endsWith(first)) return text.slice(1, -1);
  return text;
}

/** The local path of a file: URL, the same on every host (file:///C:/a%20b.png gives C:a b.png on Windows). */
function fromFileUrl(text: string, platform: NodeJS.Platform): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (platform !== 'win32') return url.hostname === '' || url.hostname === 'localhost' ? pathname : undefined;
  const local = pathname.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', BACKSLASH);
  return url.hostname ? `${BACKSLASH}${BACKSLASH}${url.hostname}${local}` : local;
}

/**
 * The absolute path when `raw` is a single path to an image file name (png, jpg, jpeg, webp, gif),
 * optionally quoted, as a file:/// URL, with ~ or relative to cwd; otherwise undefined (plain text).
 * Only the shape is checked here; the file is not touched.
 */
export function pastedImagePath(raw: string, env: PathEnv): string | undefined {
  const platform = env.platform ?? process.platform;
  const flavor = platform === 'win32' ? path.win32 : path.posix;
  let text = unquote(raw.trim());
  if (!text || text.length > 1024 || /[\n\r\0]/.test(text)) return undefined;
  if (/^file:\/\//i.test(text)) {
    const converted = fromFileUrl(text, platform);
    if (!converted) return undefined;
    text = converted;
  } else if (platform !== 'win32') {
    text = text.replaceAll(`${BACKSLASH} `, ' ');
  }
  if (!IMAGE_EXT.test(text)) return undefined;
  if (text === '~' || text.startsWith('~/') || text.startsWith(`~${BACKSLASH}`)) text = flavor.join(env.home ?? homedir(), text.slice(2));
  return flavor.isAbsolute(text) ? flavor.normalize(text) : flavor.resolve(env.cwd, text);
}

/** Loads the `--image` files of the non-interactive commands; resolves to an error message when one cannot be used. */
export async function loadImageArgs(files: readonly string[], cwd: string): Promise<{ name: string; dataUrl: string }[] | string> {
  if (files.length > MAX_IMAGES) return `Choose up to ${MAX_IMAGES} images with --image.`;
  const loaded = await Promise.all(files.map((file) => loadImageFile(path.resolve(cwd, file))));
  const images: ImageAttachment[] = [];
  for (const [index, result] of loaded.entries()) {
    if (!result) return `Image not found or not a file: ${files[index]}`;
    if (!result.ok) return result.error;
    images.push(result.image);
  }
  return toRequestImages(images);
}
