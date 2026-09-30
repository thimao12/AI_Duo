import { useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import { paint } from '../util.ts';

export interface EditState {
  value: string;
  cursor: number;
}

export interface EditResult extends EditState {
  action?: 'submit' | 'cancel';
}

/** Keeps printable characters and newlines; pasted CR/LF become newlines (spaces in a single-line field). */
export function sanitizeInput(text: string, multiline: boolean): string {
  const unified = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const flat = multiline ? unified : unified.replaceAll('\n', ' ');
  return [...flat].filter((ch) => ch === '\n' || (ch >= ' ' && ch !== '\u007f')).join('');
}

function lineStarts(value: string): number[] {
  const starts = [0];
  for (let i = 0; i < value.length; i++) if (value[i] === '\n') starts.push(i + 1);
  return starts;
}

function moveVertical({ value, cursor }: EditState, delta: number): number {
  const starts = lineStarts(value);
  const row = starts.findLastIndex((s) => s <= cursor);
  const target = row + delta;
  if (target < 0 || target >= starts.length) return cursor;
  const col = cursor - starts[row];
  const end = target + 1 < starts.length ? starts[target + 1] - 1 : value.length;
  return Math.min(starts[target] + col, end);
}

function lineBounds(value: string, cursor: number): { start: number; end: number } {
  const start = value.lastIndexOf('\n', cursor - 1) + 1;
  const next = value.indexOf('\n', cursor);
  return { start, end: next === -1 ? value.length : next };
}

/** New cursor for a navigation key, or undefined when the key is not one. */
function navigate(state: EditState, input: string, key: Key, multiline: boolean): number | undefined {
  const { value, cursor } = state;
  if (key.leftArrow) return Math.max(0, cursor - 1);
  if (key.rightArrow) return Math.min(value.length, cursor + 1);
  if (key.home || (key.ctrl && input === 'a')) return multiline ? lineBounds(value, cursor).start : 0;
  if (key.end || (key.ctrl && input === 'e')) return multiline ? lineBounds(value, cursor).end : value.length;
  if (multiline && key.upArrow) return moveVertical(state, -1);
  if (multiline && key.downArrow) return moveVertical(state, 1);
  return undefined;
}

function cut(state: EditState, from: number, to: number): EditState {
  return { value: state.value.slice(0, from) + state.value.slice(to), cursor: from };
}

const isSpace = (ch: string) => ch.trim() === '';

/** Start of the last word before `cursor`, including the whitespace that trails it. */
function wordStart(value: string, cursor: number): number {
  let at = cursor;
  while (at > 0 && isSpace(value[at - 1])) at--;
  while (at > 0 && !isSpace(value[at - 1])) at--;
  return at;
}

/** State after a deletion key, or undefined when the key is not one. */
function erase(state: EditState, input: string, key: Key): EditState | undefined {
  const { value, cursor } = state;
  if (key.backspace) return cursor > 0 ? cut(state, cursor - 1, cursor) : state;
  if (key.delete) return cursor < value.length ? cut(state, cursor, cursor + 1) : state;
  if (!key.ctrl) return undefined;
  if (input === 'u') return cut(state, 0, cursor);
  if (input === 'k') return cut(state, cursor, value.length);
  if (input === 'w') return cut(state, wordStart(value, cursor), cursor);
  return undefined;
}

function insert(state: EditState, text: string): EditState {
  return { value: state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor), cursor: state.cursor + text.length };
}

/** Pure editing step used by TextField: one key or one pasted chunk applied to the value. */
export function editText(state: EditState, input: string, key: Key, multiline = false): EditResult {
  if (key.escape) return { ...state, action: 'cancel' };
  if (key.return && !multiline) return { ...state, action: 'submit' };
  if (key.ctrl && input === 's') return { ...state, action: 'submit' };
  if (key.return) return insert(state, '\n');
  const cursor = navigate(state, input, key, multiline);
  if (cursor !== undefined) return { value: state.value, cursor };
  const erased = erase(state, input, key);
  if (erased) return erased;
  if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return state;
  return insert(state, sanitizeInput(input, multiline));
}

export interface TextFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter (single line) or Ctrl+S (multi-line). */
  onSubmit?: (value: string) => void;
  /** Esc. */
  onCancel?: () => void;
  mask?: boolean;
  multiline?: boolean;
  placeholder?: string;
  focus?: boolean;
}

function shown(text: string, mask: boolean | undefined): string {
  return mask ? '•'.repeat([...text].length) : text;
}

function Cursorline({ text, cursor, active }: Readonly<{ text: string; cursor: number | undefined; active: boolean }>) {
  if (cursor === undefined || !active) return <Text>{text || ' '}</Text>;
  const at = text.slice(cursor, cursor + 1);
  return (
    <Text>
      {text.slice(0, cursor)}
      <Text inverse>{at || ' '}</Text>
      {text.slice(cursor + 1)}
    </Text>
  );
}

/** Single-line (or multi-line) text input with a cursor; paste-safe, optionally masked. */
export default function TextField({ value, onChange, onSubmit, onCancel, mask, multiline = false, placeholder, focus = true }: Readonly<TextFieldProps>) {
  const [cursor, setCursor] = useState(value.length);
  const at = Math.min(cursor, value.length);

  useInput((input, key) => {
    const next = editText({ value, cursor: at }, input, key, multiline);
    if (next.value !== value) onChange(next.value);
    setCursor(next.cursor);
    if (next.action === 'submit') onSubmit?.(next.value);
    if (next.action === 'cancel') onCancel?.();
  }, { isActive: focus });

  if (value === '' && placeholder) {
    return <Text>{focus ? <Text inverse> </Text> : null}<Text dimColor color={paint('gray')}>{placeholder}</Text></Text>;
  }
  const text = shown(value, mask);
  const starts = lineStarts(text);
  const cursorRow = starts.findLastIndex((s) => s <= at);
  const lines = text.split('\n');
  return (
    <Box flexDirection="column">
      {lines.map((line, row) => (
        // Lines have no id of their own; their position in the text is their identity.
        <Cursorline key={starts[row]} text={line} cursor={row === cursorRow ? at - starts[row] : undefined} active={focus} />
      ))}
    </Box>
  );
}
