import { Box, measureElement, Text, useInput, type DOMElement } from 'ink';
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { applyScroll, linesBelow, scrollAction, topLine, type Anchor, type Metrics, type ScrollAction } from './scroll.ts';

export interface ViewportProps {
  children: ReactNode;
  /** Changes when the thread starts over (/clear, /new, resume): back to following. */
  resetKey: number;
  /** Changes when the user sends a message: back to following. */
  followTick: number;
  /** Scroll keys are ignored while false (a panel has the keyboard). */
  active: boolean;
  /** Plain Home/End scroll too (the composer is empty). */
  edgeKeys: boolean;
}

const NONE: Metrics = { view: 0, content: 0 };

/** Measures the viewport and its content after every layout; re-renders only when a size changed. */
function useMetrics(): { clip: RefObject<DOMElement | null>; body: RefObject<DOMElement | null>; metrics: Metrics } {
  const clip = useRef<DOMElement>(null);
  const body = useRef<DOMElement>(null);
  const [metrics, setMetrics] = useState<Metrics>(NONE);
  useLayoutEffect(() => {
    if (!clip.current || !body.current) return;
    const next = { view: measureElement(clip.current).height, content: measureElement(body.current).height };
    setMetrics((old) => (old.view === next.view && old.content === next.content ? old : next));
  });
  return { clip, body, metrics };
}

/** Anchor state plus the reset rules: back to following on a new thread or a sent message. */
function useAnchor(resetKey: number, followTick: number): { anchor: Anchor; anchorRef: RefObject<Anchor>; put: (next: Anchor) => void } {
  const [anchor, setAnchor] = useState<Anchor>(null);
  const anchorRef = useRef<Anchor>(null);
  const put = useCallback((next: Anchor) => {
    anchorRef.current = next;
    setAnchor(next);
  }, []);
  useLayoutEffect(() => {
    put(null);
  }, [resetKey, followTick, put]);
  return { anchor, anchorRef, put };
}

function NewLinesHint({ count }: Readonly<{ count: number }>) {
  const plural = count === 1 ? '' : 's';
  const text = count > 0 ? `↓ ${count} new line${plural} · End to jump` : '↓ End to jump to the latest';
  return (
    <Box position="absolute" bottom={0} right={1}>
      <Text inverse>{` ${text} `}</Text>
    </Box>
  );
}

/**
 * Scrollable region of the full-screen chat. The content is laid out at its full height inside a
 * clipped box and shifted up with a negative margin, so only what fits the viewport is drawn.
 * While following, the newest output stays in view; scrolling up pauses that.
 */
export function Viewport({ children, resetKey, followTick, active, edgeKeys }: Readonly<ViewportProps>) {
  const { clip, body, metrics } = useMetrics();
  const { anchor, anchorRef, put } = useAnchor(resetKey, followTick);
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;

  useInput(
    (_input, key) => {
      const action: ScrollAction | null = scrollAction(key, metricsRef.current, edgeKeys);
      if (action) put(applyScroll(anchorRef.current, metricsRef.current, action));
    },
    { isActive: active },
  );

  const top = topLine(anchor, metrics);
  return (
    <Box ref={clip} flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">
      <Box ref={body} flexDirection="column" flexShrink={0} marginTop={-top}>
        {children}
      </Box>
      {anchor === null ? null : <NewLinesHint count={linesBelow(anchor, metrics)} />}
    </Box>
  );
}
