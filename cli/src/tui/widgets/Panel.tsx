import type { ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import { paint } from '../util.ts';

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
export default function Panel({ title, hints = [], onClose, error, subtitle, isActive = true, children }: Readonly<PanelFrameProps>) {
  useInput((_input, key) => {
    if (key.escape) onClose?.();
  }, { isActive: isActive && onClose !== undefined });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={paint('cyan')} paddingX={1} width="100%">
      <Text bold color={paint('cyan')}>{title}</Text>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
      <Box flexDirection="column" marginTop={1}>{children}</Box>
      {error ? <Text color={paint('red')}>{error}</Text> : null}
      <Box marginTop={1}>
        <Hints hints={hints} />
      </Box>
    </Box>
  );
}
