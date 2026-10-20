import { useState, type ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import { tone } from '../theme.ts';
import { usePanelRows } from './rows.ts';
import { ScrollBody } from './ScrollBody.tsx';

/** [key, meaning] pair shown in the footer. */
export type Hint = readonly [string, string];

export interface PanelFrameProps {
  title: string;
  hints?: readonly Hint[];
  /** Esc calls this; omit when the content handles Esc itself. */
  onClose?: () => void;
  error?: string | null;
  /** Extra line under the title (a status, the current choice). */
  subtitle?: string;
  isActive?: boolean;
  /** Up/Down scroll the body when it is taller than the screen (read-only panels). */
  scrollArrows?: boolean;
  children?: ReactNode;
}

function Hints({ hints }: Readonly<{ hints: readonly Hint[] }>) {
  return (
    <Box flexWrap="wrap">
      {hints.map(([key, label], i) => (
        <Text key={key} dimColor>
          {i > 0 ? ' · ' : ''}
          <Text bold>{key}</Text> {label}
        </Text>
      ))}
    </Box>
  );
}

/** Bordered container: title, body, an inline error line and footer key hints; Esc closes it. */
/** Rows the frame itself takes: border, title, the margins around the body, and the hints line. */
const FRAME_ROWS = 6;

export default function Panel({ title, hints = [], onClose, error, subtitle, isActive = true, scrollArrows = false, children }: Readonly<PanelFrameProps>) {
  const available = usePanelRows();
  const [overflows, setOverflows] = useState(false);
  const bodyRows = available === undefined ? undefined : Math.max(1, available - FRAME_ROWS - (subtitle ? 1 : 0) - (error ? 1 : 0));
  const allHints: readonly Hint[] = overflows ? [['PgUp/PgDn', 'cuộn'], ...hints] : hints;
  useInput((_input, key) => {
    if (key.escape) onClose?.();
  }, { isActive: isActive && onClose !== undefined });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tone('cyan')} paddingX={1} width="100%">
      <Text bold color={tone('cyan')}>{title}</Text>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        <ScrollBody maxRows={bodyRows} arrowKeys={scrollArrows} onOverflow={setOverflows}>
          {children}
        </ScrollBody>
      </Box>
      {error ? <Text color={tone('red')}>{error}</Text> : null}
      <Box marginTop={1}>
        <Hints hints={allHints} />
      </Box>
    </Box>
  );
}
