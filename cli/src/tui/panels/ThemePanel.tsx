import { useState } from 'react';
import { Box, Text } from 'ink';
import type { PanelProps } from '../panel-types.ts';
import { activeTheme } from '../theme.ts';
import { supportsTrueColor, THEMES, type Theme, type Tone } from '../themes.ts';
import Panel from '../widgets/Panel.tsx';
import SelectList from '../widgets/SelectList.tsx';

const HINTS = [['↑↓', 'chọn'], ['Enter', 'áp dụng'], ['Esc', 'đóng']] as const;
const ROLES: readonly [Tone, string][] = [['cyan', 'accent'], ['green', 'ok'], ['yellow', 'warn'], ['red', 'error'], ['magenta', 'you'], ['blue', 'info'], ['gray', 'muted']];

/** The colours of a theme as a row of labelled swatches, drawn with the theme's own hex values. */
function Swatches({ theme }: Readonly<{ theme: Theme }>) {
  const plain = !!process.env.NO_COLOR;
  return (
    <Box columnGap={1} flexWrap="wrap">
      {ROLES.map(([role, label]) => (
        <Text key={role} color={plain ? undefined : theme.colors[role]}>{`● ${label}`}</Text>
      ))}
    </Box>
  );
}

/** /theme: pick a colour theme; it is applied at once and saved for the next start. */
export default function ThemePanel({ onClose, onPickTheme }: Readonly<PanelProps>) {
  const current = activeTheme();
  const [highlight, setHighlight] = useState<Theme>(THEMES.find((t) => t.id === current.id) ?? THEMES[0]);
  const truecolor = supportsTrueColor();
  return (
    <Panel
      title="Giao diện"
      subtitle={truecolor ? 'Theme màu cho toàn bộ giao diện' : 'Terminal này không hỗ trợ truecolor: dùng màu cơ bản của terminal. Hãy thử Windows Terminal.'}
      hints={HINTS}
      onClose={onClose}
    >
      <SelectList
        items={THEMES}
        getKey={(t) => t.id}
        getLabel={(t) => t.label}
        getDescription={(t) => (t.dark ? 'tối' : 'sáng')}
        isCurrent={(t) => t.id === current.id}
        initialIndex={Math.max(0, THEMES.findIndex((t) => t.id === current.id))}
        onHighlight={(t) => t && setHighlight(t)}
        onSelect={(t) => {
          onPickTheme?.(t.id);
          onClose();
        }}
        onCancel={onClose}
        maxHeight={Math.min(12, THEMES.length)}
        labelWidth={20}
      />
      <Box marginTop={1}>
        <Swatches theme={highlight} />
      </Box>
    </Panel>
  );
}
