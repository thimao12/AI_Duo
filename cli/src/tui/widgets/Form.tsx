import { useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import { paint, windowStart } from '../util.ts';
import { fitRows, usePanelRows } from './rows.ts';
import TextField from './TextField.tsx';

export interface FormField {
  id: string;
  label: string;
  /** text: Enter edits; multiline: Enter opens an editor; cycle: Left/Right/Space (and Enter, unless editable) change it. */
  kind: 'text' | 'multiline' | 'cycle';
  value: string;
  /** Values a cycle field walks through. */
  options?: readonly string[];
  /** Shown instead of a cycle value (same order as options). */
  optionLabels?: readonly string[];
  /** A cycle field that also accepts free text on Enter. */
  editable?: boolean;
  mask?: boolean;
  /** Shown when the value is empty. */
  placeholder?: string;
  /** Line under the field while it is selected. */
  hint?: string;
  /** Heading drawn above this field. */
  section?: string;
}

export interface FormProps {
  fields: readonly FormField[];
  onChange: (id: string, value: string) => void;
  /** `s` (outside a field). */
  onSave?: () => void;
  /** Esc (outside a field). */
  onCancel?: () => void;
  /** Keys the form does not use. */
  onKey?: (input: string, key: Key) => void;
  maxRows?: number;
  isActive?: boolean;
}

function stepOption(field: FormField, delta: number): string {
  const options = field.options ?? [];
  if (options.length === 0) return field.value;
  const at = options.indexOf(field.value);
  const next = at === -1 ? 0 : (at + delta + options.length) % options.length;
  return options[next];
}

export function displayValue(field: FormField): string {
  if (field.kind === 'cycle') {
    const at = field.options?.indexOf(field.value) ?? -1;
    const label = at >= 0 ? field.optionLabels?.[at] : undefined;
    return label ?? (field.value || field.placeholder || '—');
  }
  const lines = field.value.split('\n');
  const text = field.mask ? '•'.repeat(lines[0].length) : lines[0];
  const base = text || field.placeholder || '';
  return lines.length > 1 ? `${base} … (+${lines.length - 1} dòng)` : base;
}

function FieldRow({ field, selected, labelWidth }: Readonly<{ field: FormField; selected: boolean; labelWidth: number }>) {
  const cycle = field.kind === 'cycle';
  const empty = field.value === '' && !cycle;
  return (
    <Box>
      <Text color={paint('cyan')}>{selected ? '❯ ' : '  '}</Text>
      <Box width={labelWidth} flexShrink={0}>
        <Text bold={selected} wrap="truncate-end">{field.label}</Text>
      </Box>
      <Box flexShrink={1} marginLeft={1}>
        <Text wrap="truncate-end" dimColor={empty} color={selected ? paint('cyan') : undefined}>
          {cycle && selected ? '◂ ' : ''}
          {displayValue(field)}
          {cycle && selected ? ' ▸' : ''}
        </Text>
      </Box>
    </Box>
  );
}

interface EditorProps {
  field: FormField;
  onChange: (value: string) => void;
  onDone: () => void;
}

function Editor({ field, onChange, onDone }: Readonly<EditorProps>) {
  const multiline = field.kind === 'multiline';
  const help = multiline ? 'Ctrl+S / Esc xong · Enter xuống dòng' : 'Enter xong · Esc xong';
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={paint('yellow')} paddingX={1}>
      <Text dimColor>{`${field.label} · ${help}`}</Text>
      <TextField value={field.value} onChange={onChange} mask={field.mask} multiline={multiline} placeholder={field.placeholder} onSubmit={onDone} onCancel={onDone} />
    </Box>
  );
}

/** Vertical list of labelled fields: Up/Down move, Enter/Left/Right/Space change the selected one, `s` saves. */
export default function Form({ fields, onChange, onSave, onCancel, onKey, isActive = true, ...rest }: Readonly<FormProps>) {
  const maxRows = fitRows(rest.maxRows ?? 12, usePanelRows());
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const at = Math.min(index, Math.max(0, fields.length - 1));
  const field = fields[at] as FormField | undefined;
  const change = (delta: number) => {
    if (field?.kind === 'cycle') onChange(field.id, stepOption(field, delta));
  };
  const enter = () => {
    if (field?.kind !== 'cycle' || field.editable) setEditing(true);
    else change(1);
  };

  useInput((input, key) => {
    if (key.upArrow || input === 'k') setIndex(Math.max(0, at - 1));
    else if (key.downArrow || input === 'j') setIndex(Math.min(fields.length - 1, at + 1));
    else if (key.leftArrow) change(-1);
    else if (key.rightArrow || input === ' ') change(1);
    else if (key.return) enter();
    else if (key.escape) onCancel?.();
    else if (input === 's' && onSave) onSave();
    else onKey?.(input, key);
  }, { isActive: isActive && !editing });

  const width = Math.min(24, Math.max(...fields.map((f) => f.label.length)) + 1);
  const top = windowStart(fields.length, at, maxRows);
  return (
    <Box flexDirection="column">
      {fields.slice(top, top + maxRows).map((f) => (
        <Box key={f.id} flexDirection="column">
          {f.section ? <Text bold color={paint('magenta')}>{f.section}</Text> : null}
          <FieldRow field={f} selected={f === field} labelWidth={width} />
        </Box>
      ))}
      {fields.length > maxRows ? <Text dimColor>{`  ${at + 1}/${fields.length}${top > 0 ? ' ▲' : ''}${top + maxRows < fields.length ? ' ▼' : ''}`}</Text> : null}
      {field?.hint && !editing ? <Text dimColor>{field.hint}</Text> : null}
      {editing && field ? <Editor field={field} onChange={(v) => onChange(field.id, v)} onDone={() => setEditing(false)} /> : null}
    </Box>
  );
}
