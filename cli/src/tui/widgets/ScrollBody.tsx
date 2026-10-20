import { Box, measureElement, Text, useInput, type DOMElement } from 'ink';
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { maxTop, pageSize, WHEEL_LINES, type Metrics } from '../scroll.ts';
import { WheelContext } from '../Viewport.tsx';

export interface ScrollBodyProps {
  children: ReactNode;
  /** Rows the body may use; undefined = no limit (nothing is clipped or scrolled). */
  maxRows: number | undefined;
  /** Up/Down scroll too; off for bodies whose widgets use the arrows themselves. */
  arrowKeys?: boolean;
  /** Called when the content turns out taller than the viewport (or not any more). */
  onOverflow?: (overflows: boolean) => void;
}

const NONE: Metrics = { view: 0, content: 0 };

/** Content clipped to `maxRows` and scrolled from the top by wheel, PageUp/PageDown, Home/End (and arrows). */
export function ScrollBody({ children, maxRows, arrowKeys = false, onOverflow }: Readonly<ScrollBodyProps>) {
  const body = useRef<DOMElement>(null);
  const [metrics, setMetrics] = useState<Metrics>(NONE);
  const [top, setTop] = useState(0);
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;

  useLayoutEffect(() => {
    if (!body.current || maxRows === undefined) return;
    const content = measureElement(body.current).height;
    const next = { view: Math.min(content, Math.max(1, maxRows)), content };
    setMetrics((old) => (old.view === next.view && old.content === next.content ? old : next));
  });

  const max = maxTop(metrics);
  const shown = Math.min(top, max);
  const overflows = max > 0;
  useEffect(() => {
    onOverflow?.(overflows);
  }, [overflows, onOverflow]);

  const scrollBy = (lines: number) => setTop(() => Math.min(maxTop(metricsRef.current), Math.max(0, Math.min(top, maxTop(metricsRef.current)) + lines)));

  useInput(
    (_input, key) => {
      if (key.pageUp) scrollBy(-pageSize(metricsRef.current));
      else if (key.pageDown) scrollBy(pageSize(metricsRef.current));
      else if (key.home) setTop(0);
      else if (key.end) setTop(maxTop(metricsRef.current));
      else if (arrowKeys && key.upArrow) scrollBy(-1);
      else if (arrowKeys && key.downArrow) scrollBy(1);
    },
    { isActive: maxRows !== undefined && overflows },
  );

  const wheel = useContext(WheelContext);
  useEffect(() => {
    if (!wheel || maxRows === undefined) return;
    return wheel.onWheel((direction) => scrollBy(direction === 'up' ? -WHEEL_LINES : WHEEL_LINES));
  });

  if (maxRows === undefined) return <Box flexDirection="column">{children}</Box>;
  const above = shown;
  const below = max - shown;
  return (
    <Box flexDirection="column" height={Math.max(1, metrics.view || maxRows)} flexShrink={0}>
      <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">
        <Box ref={body} flexDirection="column" flexShrink={0} marginTop={-shown}>
          {children}
        </Box>
        {overflows ? (
          <Box position="absolute" bottom={0} right={0}>
            <Text inverse>{` ${above > 0 ? `↑ ${above}` : ''}${above > 0 && below > 0 ? ' ' : ''}${below > 0 ? `↓ ${below}` : ''} `}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
