import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import { paint, windowStart } from '../util.ts';
import { fitRows, usePanelRows } from './rows.ts';

export interface SelectListProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  getDescription?: (item: T) => string | undefined;
  /** Marks the item that is currently in effect. */
  isCurrent?: (item: T) => boolean;
  /** Colour of an item's label. */
  getColor?: (item: T) => string | undefined;
  onSelect?: (item: T) => void;
  /** Esc; with a filter typed, Esc clears the filter first. */
  onCancel?: () => void;
  onHighlight?: (item: T | undefined) => void;
  /** Keys the list does not use itself (in filter mode only non-printable ones). */
  onKey?: (input: string, key: Key, item: T | undefined) => void;
  /** Rows shown at once; the list scrolls when it has more. */
  maxHeight?: number;
  /** Typing narrows the list; j/k then are letters, not navigation. */
  filterable?: boolean;
  filterText?: (item: T) => string;
  isActive?: boolean;
  emptyText?: string;
  /** Width of the label column (default: fitted to the longest label, at most 34). */
  labelWidth?: number;
  initialIndex?: number;
}

const MAX_LABEL = 34;

function moveIndex(index: number, total: number, input: string, key: Key, letters: boolean, height: number): number | undefined {
  if (key.upArrow || (letters && input === 'k')) return Math.max(0, index - 1);
  if (key.downArrow || (letters && input === 'j')) return Math.min(total - 1, index + 1);
  if (key.pageUp) return Math.max(0, index - height);
  if (key.pageDown) return Math.min(total - 1, index + height);
  if (key.home) return 0;
  if (key.end) return total - 1;
  return undefined;
}

const isPrintable = (input: string, key: Key) => input !== '' && !key.ctrl && !key.meta && !key.return && !key.tab && !key.escape;

function useFilter<T>(items: readonly T[], enabled: boolean, text: ((item: T) => string) | undefined, label: (item: T) => string) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!enabled || !needle) return items;
    return items.filter((item) => (text?.(item) ?? label(item)).toLowerCase().includes(needle));
  }, [items, enabled, filter, text, label]);
  return { filter, setFilter, shown };
}

function Row<T>({ item, selected, props, width }: Readonly<{ item: T; selected: boolean; props: SelectListProps<T>; width: number }>) {
  const color = props.getColor?.(item);
  const description = props.getDescription?.(item);
  return (
    <Box>
      <Text color={paint('cyan')}>{selected ? '❯ ' : '  '}</Text>
      <Text color={paint('green')}>{props.isCurrent?.(item) ? '● ' : '  '}</Text>
      <Box width={width} flexShrink={0}>
        <Text wrap="truncate-end" bold={selected} color={selected ? paint('cyan') : color}>{props.getLabel(item)}</Text>
      </Box>
      {description ? (
        <Box flexGrow={1} flexShrink={1} marginLeft={1}>
          <Text wrap="truncate-end" dimColor>{description}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** Keyboard list: Up/Down (j/k), PgUp/PgDn, Enter selects, Esc cancels; scrolls past maxHeight; optional type-to-filter. */
export default function SelectList<T>(props: Readonly<SelectListProps<T>>) {
  const { items, getKey, getLabel, onSelect, onCancel, onHighlight, onKey, filterable = false, isActive = true } = props;
  const maxHeight = fitRows(props.maxHeight ?? 10, usePanelRows());
  const { filter, setFilter, shown } = useFilter(items, filterable, props.filterText, getLabel);
  const [index, setIndex] = useState(props.initialIndex ?? 0);
  const at = Math.min(index, Math.max(0, shown.length - 1));
  const current = shown[at] as T | undefined;
  const currentKey = current === undefined ? undefined : getKey(current);

  useEffect(() => {
    onHighlight?.(current);
    // Keyed by id, not by object: parents rebuild their item objects on every render.
    // onHighlight is deliberately not a dependency: parents pass fresh closures too.
  }, [currentKey]);

  useInput((input, key) => {
    const to = moveIndex(at, shown.length, input, key, !filterable, maxHeight);
    if (to !== undefined) {
      setIndex(to);
    } else if (key.return) {
      if (current !== undefined) onSelect?.(current);
    } else if (key.escape) {
      if (filter) setFilter('');
      else onCancel?.();
    } else if (filterable && (key.backspace || key.delete)) {
      setFilter(filter.slice(0, -1));
    } else if (filterable && isPrintable(input, key)) {
      setIndex(0);
      setFilter(filter + [...input].filter((ch) => ch >= ' ').join(''));
    } else {
      onKey?.(input, key, current);
    }
  }, { isActive });

  const width = props.labelWidth ?? Math.min(MAX_LABEL, Math.max(8, ...shown.map((item) => getLabel(item).length)));
  const top = windowStart(shown.length, at, maxHeight);
  const visible = shown.slice(top, top + maxHeight);
  return (
    <Box flexDirection="column">
      {filterable ? (
        <Text>
          <Text dimColor>Lọc: </Text>
          {filter || <Text dimColor>gõ để lọc</Text>}
        </Text>
      ) : null}
      {visible.length === 0 ? <Text dimColor>{props.emptyText ?? 'Không có mục nào.'}</Text> : null}
      {visible.map((item) => (
        <Row key={getKey(item)} item={item} selected={item === current} props={props} width={width} />
      ))}
      {shown.length > maxHeight ? <Text dimColor>{`  ${at + 1}/${shown.length}${top > 0 ? ' ▲' : ''}${top + maxHeight < shown.length ? ' ▼' : ''}`}</Text> : null}
    </Box>
  );
}
