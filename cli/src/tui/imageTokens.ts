import { formatBytes, shortType, type ImageAttachment } from './images.ts';

/** An attached image and its stable number: the `[Image #N]` token in the prompt text refers to it. */
export interface Attached {
  num: number;
  image: ImageAttachment;
}

/** One token occurrence in a text: offsets [start, end). */
export interface TokenSpan {
  start: number;
  end: number;
  num: number;
}

export const tokenOf = (num: number): string => `[Image #${num}]`;

const NBSP = String.fromCodePoint(0xa0);

/** The token as drawn: the inner space is a no-break space so a wrapping line never splits the token. */
export const displayToken = (token: string): string => token.replace(' ', NBSP);

const TOKEN_PATTERN = /\[Image #(\d+)\]/g;

/** Tokens in `text` that have an attachment; anything else that looks like a token is plain text. */
export function tokenSpans(text: string, images: readonly Attached[]): TokenSpan[] {
  if (images.length === 0) return [];
  const known = new Set(images.map((a) => a.num));
  const spans: TokenSpan[] = [];
  for (const m of text.matchAll(TOKEN_PATTERN)) {
    const num = Number(m[1]);
    if (known.has(num)) spans.push({ start: m.index, end: m.index + m[0].length, num });
  }
  return spans;
}

/** The smallest free number. */
export function nextNumber(images: readonly Attached[]): number {
  const used = new Set(images.map((a) => a.num));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** Keeps the attachments that still have a token in `text`. */
export function reconcileImages(text: string, images: readonly Attached[]): Attached[] {
  const present = new Set(tokenSpans(text, images).map((s) => s.num));
  return images.filter((a) => present.has(a.num));
}

/**
 * What is sent: images in number order and the tokens renumbered to match their position
 * (#2 removed from #1,#2,#3: the old #3 becomes #2).
 */
export function renumberForSend(text: string, images: readonly Attached[]): { text: string; images: ImageAttachment[] } {
  const sorted = [...images].sort((a, b) => a.num - b.num);
  const position = new Map(sorted.map((a, i) => [a.num, i + 1]));
  const out = text.replaceAll(TOKEN_PATTERN, (whole, n: string) => {
    const at = position.get(Number(n));
    return at === undefined ? whole : tokenOf(at);
  });
  return { text: out, images: sorted.map((a) => a.image) };
}

/** History keeps no attachments: a token becomes the plain word `[image]`. */
export const historyText = (text: string): string => text.replaceAll(TOKEN_PATTERN, '[image]');

/** "Image #1 shot.png PNG 184 KB" (the file name only for files; a clipboard image has none worth showing). */
export function attachmentLine(a: Attached): string {
  const parts = [`Image #${a.num}`];
  if (a.image.source === 'file') parts.push(a.image.name);
  parts.push(shortType(a.image.mime), formatBytes(a.image.bytes));
  return parts.join(' ');
}

/** The attachments as one dim line of at most `width` columns (whole entries only); '' when not even one fits. */
export function attachmentSummary(images: readonly Attached[], width: number): string {
  const lines = [...images].sort((a, b) => a.num - b.num).map(attachmentLine);
  let out = '';
  for (const line of lines) {
    const next = out ? `${out} · ${line}` : line;
    if (next.length > width) break;
    out = next;
  }
  return out;
}

export interface Segment {
  /** Offset of the segment inside the sliced text. */
  at: number;
  text: string;
  token: boolean;
}

/** Splits the slice [base, base + text.length) of the whole text into plain and token segments. */
export function segments(text: string, base: number, spans: readonly TokenSpan[]): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const span of spans) {
    const start = span.start - base;
    const end = span.end - base;
    if (start < at || end > text.length) continue;
    if (start > at) out.push({ at, text: text.slice(at, start), token: false });
    out.push({ at: start, text: text.slice(start, end), token: true });
    at = end;
  }
  if (at < text.length) out.push({ at, text: text.slice(at), token: false });
  return out;
}
