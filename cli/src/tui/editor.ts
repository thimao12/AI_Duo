import type { Key } from 'ink';
import { MAX_IMAGES, type ImageAttachment } from './images.ts';
import { nextNumber, reconcileImages, tokenOf, tokenSpans, type Attached, type TokenSpan } from './imageTokens.ts';

/**
 * Pure text-editing state of the composer: the text and the cursor as a string offset. `images` are the
 * attached images; each has an `[Image #N]` token in the text, which the editor treats as one atomic unit
 * (the cursor never sits inside it, deleting any part of it deletes all of it and the attachment).
 */
export interface EditorState {
  text: string;
  cursor: number;
  images?: readonly Attached[];
}

/** The state with new text and cursor; attachments whose token is gone are dropped. */
function make(s: EditorState, text: string, cursor: number): EditorState {
  const images = reconcileImages(text, s.images ?? []);
  return images.length > 0 ? { text, cursor, images } : { text, cursor };
}

export const spansOf = (s: EditorState): TokenSpan[] => tokenSpans(s.text, s.images ?? []);

/** `at` moved out of a token it is inside: to its start (down) or end (up). */
function snapDown(spans: readonly TokenSpan[], at: number): number {
  return spans.find((sp) => sp.start < at && at < sp.end)?.start ?? at;
}

function snapUp(spans: readonly TokenSpan[], at: number): number {
  return spans.find((sp) => sp.start < at && at < sp.end)?.end ?? at;
}

export const EMPTY_EDITOR: EditorState = { text: '', cursor: 0 };

export const editorOf = (text: string, images?: readonly Attached[]): EditorState => make({ text, cursor: text.length, images }, text, text.length);

/** True when the code point needs a surrogate pair (two UTF-16 units). */
const isAstral = (code: number | undefined) => code !== undefined && code > 0xffff;

/** Combining diacritical marks (Vietnamese tones and horns arrive as these when decomposed). */
export const isCombining = (code: number | undefined) => code !== undefined && code >= 0x300 && code <= 0x36f;

/** Offset of the code point before `at` (one code point, not one UTF-16 unit). */
function prevCodePoint(text: string, at: number): number {
  if (at >= 2 && isAstral(text.codePointAt(at - 2))) return at - 2;
  return Math.max(0, at - 1);
}

/** Offset one visible character before `at`: a base letter together with its combining marks. */
export function before(text: string, at: number): number {
  let i = prevCodePoint(text, at);
  while (i > 0 && isCombining(text.codePointAt(i))) i = prevCodePoint(text, i);
  return i;
}

/** Offset one visible character after `at`: a base letter together with its combining marks. */
export function after(text: string, at: number): number {
  if (at >= text.length) return text.length;
  let i = at + (isAstral(text.codePointAt(at)) ? 2 : 1);
  while (i < text.length && isCombining(text.codePointAt(i))) i++;
  return Math.min(text.length, i);
}

/** Pasted and typed text: line breaks normalised, control characters dropped. */
export function cleanInput(input: string): string {
  let out = '';
  const text = input.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  for (const ch of text) {
    if (ch === '\n' || ch === '\t' || ch >= ' ') out += ch === '\t' ? '  ' : ch;
  }
  return out;
}

/**
 * Inserts typed or pasted text as NFC. When the chunk starts with a combining mark (an IME sending
 * a letter and its tone separately) the letter before the cursor joins the composition.
 */
export function insertText(s: EditorState, input: string): EditorState {
  const text = cleanInput(input);
  if (!text) return s;
  // A combining mark joins the letter before the cursor, but never the closing bracket of a token.
  const joins = isCombining(text.codePointAt(0)) && !spansOf(s).some((sp) => sp.end === s.cursor);
  const from = joins ? before(s.text, s.cursor) : s.cursor;
  const piece = (s.text.slice(from, s.cursor) + text).normalize('NFC');
  return make(s, s.text.slice(0, from) + piece + s.text.slice(s.cursor), from + piece.length);
}

/**
 * Attaches an image: inserts its `[Image #N]` token at the cursor (N = smallest free number), plus a
 * space when the next character is not whitespace. undefined when the images are at the limit.
 */
export function insertImage(s: EditorState, image: ImageAttachment): EditorState | undefined {
  const current = s.images ?? [];
  if (current.length >= MAX_IMAGES) return undefined;
  const num = nextNumber(current);
  const next = s.text[s.cursor];
  const gap = next === undefined || isSpace(next) ? '' : ' ';
  const piece = tokenOf(num) + gap;
  return {
    text: s.text.slice(0, s.cursor) + piece + s.text.slice(s.cursor),
    cursor: s.cursor + piece.length,
    images: [...current, { num, image }],
  };
}

/** Removes every token and attachment (/clear-images). */
export function clearImages(s: EditorState): EditorState {
  let text = s.text;
  let cursor = s.cursor;
  for (const sp of spansOf(s).reverse()) {
    text = text.slice(0, sp.start) + text.slice(sp.end);
    if (sp.end <= cursor) cursor -= sp.end - sp.start;
  }
  return { text, cursor };
}

/** Deletes [from, to), widened so that a token cut by either end goes completely. */
function cut(s: EditorState, from: number, to: number): EditorState {
  const spans = spansOf(s);
  const start = snapDown(spans, from);
  return make(s, s.text.slice(0, start) + s.text.slice(snapUp(spans, to)), start);
}

export function backspace(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  return cut(s, before(s.text, s.cursor), s.cursor);
}

export function deleteForward(s: EditorState): EditorState {
  if (s.cursor >= s.text.length) return s;
  return cut(s, s.cursor, after(s.text, s.cursor));
}

const moveTo = (s: EditorState, cursor: number): EditorState => ({ ...s, cursor });

export const moveLeft = (s: EditorState): EditorState => moveTo(s, snapDown(spansOf(s), before(s.text, s.cursor)));
export const moveRight = (s: EditorState): EditorState => moveTo(s, snapUp(spansOf(s), after(s.text, s.cursor)));

/** Start and end offsets of the logical line holding the cursor. */
export function lineBounds(s: EditorState): { start: number; end: number } {
  const start = s.text.lastIndexOf('\n', s.cursor - 1) + 1;
  const next = s.text.indexOf('\n', s.cursor);
  return { start, end: next < 0 ? s.text.length : next };
}

export const lineStart = (s: EditorState): EditorState => ({ ...s, cursor: lineBounds(s).start });
export const lineEnd = (s: EditorState): EditorState => ({ ...s, cursor: lineBounds(s).end });

export function cursorPosition(s: EditorState): { row: number; col: number } {
  const upTo = s.text.slice(0, s.cursor);
  const row = upTo.split('\n').length - 1;
  return { row, col: s.cursor - (upTo.lastIndexOf('\n') + 1) };
}

export const lineCount = (s: EditorState): number => s.text.split('\n').length;

/** Up (-1) or down (+1) one logical line, keeping the column; undefined at the first/last line. */
export function moveVertical(s: EditorState, dir: -1 | 1): EditorState | undefined {
  const { row, col } = cursorPosition(s);
  const lines = s.text.split('\n');
  const target = row + dir;
  if (target < 0 || target >= lines.length) return undefined;
  let offset = 0;
  for (let i = 0; i < target; i++) offset += lines[i].length + 1;
  return moveTo(s, snapDown(spansOf(s), offset + Math.min(col, lines[target].length)));
}

const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\n' || ch === '\t';

export function wordLeftOffset(text: string, at: number): number {
  let i = at;
  while (i > 0 && isSpace(text[i - 1])) i--;
  while (i > 0 && !isSpace(text[i - 1])) i--;
  return i;
}

export function wordRightOffset(text: string, at: number): number {
  let i = at;
  while (i < text.length && isSpace(text[i])) i++;
  while (i < text.length && !isSpace(text[i])) i++;
  return i;
}

export const wordLeft = (s: EditorState): EditorState => moveTo(s, snapDown(spansOf(s), wordLeftOffset(s.text, s.cursor)));
export const wordRight = (s: EditorState): EditorState => moveTo(s, snapUp(spansOf(s), wordRightOffset(s.text, s.cursor)));

export const deleteWordBack = (s: EditorState): EditorState => cut(s, wordLeftOffset(s.text, s.cursor), s.cursor);
export const deleteWordForward = (s: EditorState): EditorState => cut(s, s.cursor, wordRightOffset(s.text, s.cursor));
export const deleteToLineStart = (s: EditorState): EditorState => cut(s, lineBounds(s).start, s.cursor);
export const deleteToLineEnd = (s: EditorState): EditorState => cut(s, s.cursor, lineBounds(s).end);

type Edit = (s: EditorState) => EditorState;

const CTRL_LETTERS: Record<string, Edit> = {
  a: lineStart,
  e: lineEnd,
  b: moveLeft,
  f: moveRight,
  h: backspace,
  d: deleteForward,
  u: deleteToLineStart,
  k: deleteToLineEnd,
  w: deleteWordBack,
};

const META_LETTERS: Record<string, Edit> = { b: wordLeft, f: wordRight, d: deleteWordForward };

/** The edit for a navigation or deletion key, or undefined when the key is not one. */
function namedKeyEdit(key: Key): Edit | undefined {
  const jump = key.ctrl || key.meta;
  if (key.leftArrow) return jump ? wordLeft : moveLeft;
  if (key.rightArrow) return jump ? wordRight : moveRight;
  if (key.home) return lineStart;
  if (key.end) return lineEnd;
  if (key.backspace) return jump ? deleteWordBack : backspace;
  if (key.delete) return jump ? deleteWordForward : deleteForward;
  return undefined;
}

/**
 * Applies one key to the editor; undefined when the key is not an editing key (Enter, Tab, Up/Down,
 * Esc… are the caller's). Typed and pasted text arrives as `input`.
 */
export function applyEditKey(s: EditorState, input: string, key: Key): EditorState | undefined {
  const named = namedKeyEdit(key);
  if (named) return named(s);
  if (key.ctrl) return CTRL_LETTERS[input]?.(s);
  if (key.meta) return META_LETTERS[input]?.(s);
  if (input && !key.escape && !key.return && !key.tab) return insertText(s, input);
  return undefined;
}
