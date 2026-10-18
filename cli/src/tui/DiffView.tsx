import { Box, Text } from 'ink';
import type { DiffLine, FileDiff } from './diff.ts';
import { activeTheme, tone } from './theme.ts';

/** Rows of a diff: line number, +/- marker and the text on a red or green band, like a code review. */

const MAX_ROWS_DEFAULT = 40;

const pad = (text: string, width: number) => (text.length >= width ? text : text + ' '.repeat(width - text.length));

/** Cuts a long line so its band stays on one row. */
function fit(text: string, width: number): string {
  const flat = text.replaceAll('\t', '  ');
  return flat.length > width ? `${flat.slice(0, Math.max(0, width - 1))}…` : flat;
}

function DiffRow({ line, noWidth, width }: Readonly<{ line: DiffLine; noWidth: number; width: number }>) {
  const theme = activeTheme();
  const plain = !!process.env.NO_COLOR;
  // Without truecolor the bands would be harsh solid blocks: colour the text instead.
  const bands = !plain && theme.id !== 'default';
  const no = line.kind === 'del' ? line.oldNo : (line.newNo ?? line.oldNo);
  const gutter = pad(no === undefined ? '' : String(no), noWidth);
  if (line.kind === 'ctx' && no === undefined) return <Text dimColor>{`${' '.repeat(noWidth)}   ${line.text}`}</Text>;
  const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
  const body = fit(line.text, Math.max(10, width - noWidth - 4));
  if (line.kind === 'ctx') {
    return (
      <Text>
        <Text color={plain ? undefined : theme.diff.gutter}>{`${gutter}  `}</Text>
        <Text dimColor>{` ${body}`}</Text>
      </Text>
    );
  }
  const add = line.kind === 'add';
  const bg = bands ? (add ? theme.diff.addBg : theme.diff.delBg) : undefined;
  const fg = plain ? undefined : add ? theme.diff.addFg : theme.diff.delFg;
  const text = bands ? pad(` ${body}`, width - noWidth - 3) : ` ${body}`;
  return (
    <Text backgroundColor={bg}>
      <Text color={plain ? undefined : theme.diff.gutter}>{`${gutter} `}</Text>
      <Text color={fg} bold>{marker}</Text>
      <Text>{text}</Text>
    </Text>
  );
}

interface DiffViewProps {
  lines: readonly DiffLine[];
  width: number;
  /** Rows shown before "… N more lines". */
  maxRows?: number;
}

/** A diff body (no header); the number column is as wide as the largest line number. */
export function DiffView({ lines, width, maxRows = MAX_ROWS_DEFAULT }: Readonly<DiffViewProps>) {
  const shown = lines.slice(0, maxRows);
  const largest = shown.reduce((max, l) => Math.max(max, l.oldNo ?? 0, l.newNo ?? 0), 0);
  const noWidth = Math.max(2, String(largest).length);
  return (
    <Box flexDirection="column">
      {shown.map((line, index) => (
        <DiffRow key={index} line={line} noWidth={noWidth} width={Math.max(20, width)} />
      ))}
      {lines.length > shown.length ? <Text dimColor>{`  … ${lines.length - shown.length} more line(s)`}</Text> : null}
    </Box>
  );
}

/** One file of a diff: `path +a −r` and its rows. */
export function FileDiffView({ file, width, maxRows }: Readonly<{ file: FileDiff; width: number; maxRows?: number }>) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text wrap="truncate-end">
        <Text bold>{file.path}</Text>
        <Text color={tone('green')}>{` +${file.added}`}</Text>
        <Text color={tone('red')}>{` −${file.removed}`}</Text>
        {file.note ? <Text dimColor>{` · ${file.note}`}</Text> : null}
      </Text>
      <DiffView lines={file.lines} width={width} maxRows={maxRows} />
    </Box>
  );
}
