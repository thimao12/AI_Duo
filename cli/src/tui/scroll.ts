import type { Key } from 'ink';

/** Rows of the viewport and of the content inside it. */
export interface Metrics {
  view: number;
  content: number;
}

export type ScrollAction = { kind: 'by'; lines: number } | { kind: 'top' } | { kind: 'bottom' };

/**
 * Scroll position is an anchor: the first content line shown, or null while following the newest
 * output. An anchor keeps the same lines on screen when new output arrives below.
 */
export type Anchor = number | null;

export const maxTop = (m: Metrics): number => Math.max(0, m.content - m.view);

export const topLine = (anchor: Anchor, m: Metrics): number => (anchor === null ? maxTop(m) : Math.min(anchor, maxTop(m)));

/** Lines of output below the viewport (only meaningful while not following). */
export const linesBelow = (anchor: Anchor, m: Metrics): number => (anchor === null ? 0 : maxTop(m) - topLine(anchor, m));

export const pageSize = (m: Metrics): number => Math.max(1, m.view - 1);

/** New anchor after `action`; reaching the bottom resumes following. */
export function applyScroll(anchor: Anchor, m: Metrics, action: ScrollAction): Anchor {
  if (action.kind === 'bottom') return null;
  const max = maxTop(m);
  const next = action.kind === 'top' ? 0 : Math.min(max, Math.max(0, topLine(anchor, m) + action.lines));
  return next >= max ? null : next;
}

/**
 * The scroll action a key stands for, or null. Plain Up/Down stay with the composer (history);
 * plain Home/End only scroll when `edgeKeys` says the composer has nothing to move in.
 */
export function scrollAction(key: Key, m: Metrics, edgeKeys: boolean): ScrollAction | null {
  const modified = key.ctrl || key.meta;
  if (key.pageUp) return { kind: 'by', lines: -pageSize(m) };
  if (key.pageDown) return { kind: 'by', lines: pageSize(m) };
  if (modified && key.upArrow) return { kind: 'by', lines: -1 };
  if (modified && key.downArrow) return { kind: 'by', lines: 1 };
  if (key.home && (modified || edgeKeys)) return { kind: 'top' };
  if (key.end && (modified || edgeKeys)) return { kind: 'bottom' };
  return null;
}

/** Keys the viewport owns even while the composer is focused; the composer skips them. */
export function isScrollKey(key: Key): boolean {
  const modified = key.ctrl || key.meta;
  return key.pageUp || key.pageDown || (modified && (key.upArrow || key.downArrow || key.home || key.end));
}
