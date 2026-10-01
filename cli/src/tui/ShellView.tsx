import { Box, Text } from 'ink';
import type { ShellLine } from './shell.ts';
import { tone } from './theme.ts';
import { formatDuration, type ThreadItem } from './thread.ts';

export type ShellItem = Extract<ThreadItem, { kind: 'shell' }>;

/** "1.2s" under a minute, "2m05s" above. */
export function shellDuration(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms);
}

interface Footer {
  text: string;
  color?: 'red' | 'yellow';
}

/** The last line of a command block: exit status and time, or why it did not finish. */
export function shellFooter(item: ShellItem): Footer {
  const time = shellDuration(item.ms);
  switch (item.state) {
    case 'running':
      return { text: 'running… Ctrl+C stops it' };
    case 'interrupted':
      return { text: `interrupted · ${time}`, color: 'yellow' };
    case 'timeout':
      return { text: `timed out after ${time}`, color: 'red' };
    case 'failed':
      return { text: `could not start: ${item.error ?? 'unknown error'}`, color: 'red' };
    default:
      return item.code === 0 ? { text: `exit 0 · ${time}` } : { text: `exit ${item.code ?? '?'} · ${time}`, color: 'red' };
  }
}

interface Group {
  id: number;
  stream: ShellLine['stream'];
  text: string;
}

/** Consecutive lines of one stream become one Text, so a long output is a few nodes, not thousands. */
export function groupLines(lines: readonly ShellLine[]): Group[] {
  const groups: Group[] = [];
  for (const line of lines) {
    const last = groups.at(-1);
    if (last?.stream === line.stream) last.text += `\n${line.text}`;
    else groups.push({ id: groups.length, stream: line.stream, text: line.text });
  }
  return groups;
}

function CommandLines({ command }: Readonly<{ command: string }>) {
  const rows = command.split('\n').map((text, id) => ({ id, text }));
  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        <Text key={row.id} dimColor>
          <Text bold color={tone('magenta')}>
            {row.id === 0 ? '! ' : '  '}
          </Text>
          {row.text}
        </Text>
      ))}
    </Box>
  );
}

/**
 * A shell-mode command and its output, local to the thread. `maxLines` shows only the newest lines
 * (the live block, so it never outgrows the terminal).
 */
export function ShellBlock({ item, maxLines }: Readonly<{ item: ShellItem; maxLines?: number }>) {
  const limit = maxLines ?? item.lines.length;
  const hiddenLines = Math.max(0, item.lines.length - limit);
  const shown = hiddenLines > 0 ? item.lines.slice(-limit) : item.lines;
  const footer = shellFooter(item);
  return (
    <Box flexDirection="column" marginTop={1}>
      <CommandLines command={item.command} />
      {hiddenLines > 0 ? <Text dimColor>{`… ${hiddenLines} earlier line(s)`}</Text> : null}
      {groupLines(shown).map((group) => {
        const color = group.stream === 'err' ? tone('red') : undefined;
        return (
          <Text key={group.id} color={color} dimColor={group.stream === 'note'}>
            {group.text}
          </Text>
        );
      })}
      <Text dimColor={footer.color === undefined} color={footer.color ? tone(footer.color) : undefined}>
        {footer.text}
      </Text>
      {item.hint ? <Text dimColor>{item.hint}</Text> : null}
    </Box>
  );
}
