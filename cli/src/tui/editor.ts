import type { Key } from 'ink';

/** Pure text-editing state of the composer: the text and the cursor as a string offset. */
export interface EditorState {
  text: string;
  cursor: number;
}

export const EMPTY_EDITOR: EditorState = { text: '', cursor: 0 };

export const editorOf = (text: string): EditorState => ({ text, cursor: text.length });

/** True when the code point needs a surrogate pair (two UTF-16 units). */
const isAstral = (code: number | undefined) => code !== undefined && code > 0xffff;

/** Offset one character (not one UTF-16 unit) before `at`. */
function before(text: string, at: number): number {
  if (at >= 2 && isAstral(text.codePointAt(at - 2))) return at - 2;
  return Math.max(0, at - 1);
}

function after(text: string, at: number): number {
  if (isAstral(text.codePointAt(at))) return at + 2;
  return Math.min(text.length, at + 1);
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

export function insertText(s: EditorState, input: string): EditorState {
  const text = cleanInput(input);
  if (!text) return s;
  return { text: s.text.slice(0, s.cursor) + text + s.text.slice(s.cursor), cursor: s.cursor + text.length };
}

export function backspace(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  const from = before(s.text, s.cursor);
  return { text: s.text.slice(0, from) + s.text.slice(s.cursor), cursor: from };
}

export function deleteForward(s: EditorState): EditorState {
  if (s.cursor >= s.text.length) return s;
  return { text: s.text.slice(0, s.cursor) + s.text.slice(after(s.text, s.cursor)), cursor: s.cursor };
}

export const moveLeft = (s: EditorState): EditorState => ({ ...s, cursor: before(s.text, s.cursor) });
export const moveRight = (s: EditorState): EditorState => ({ ...s, cursor: after(s.text, s.cursor) });

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
  return { ...s, cursor: offset + Math.min(col, lines[target].length) };
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

export const wordLeft = (s: EditorState): EditorState => ({ ...s, cursor: wordLeftOffset(s.text, s.cursor) });
export const wordRight = (s: EditorState): EditorState => ({ ...s, cursor: wordRightOffset(s.text, s.cursor) });

function cut(s: EditorState, from: number, to: number): EditorState {
  return { text: s.text.slice(0, from) + s.text.slice(to), cursor: from };
}

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
