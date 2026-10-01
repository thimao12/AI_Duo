import { Box, Text } from 'ink';
import { memo } from 'react';
import type { Message, Run } from '../../../server/src/types.ts';
import { MessageView, UserLine } from './MessageView.tsx';
import { ShellBlock } from './ShellView.tsx';
import { tone } from './theme.ts';
import { effortFor, formatUsageLine, oneLine, summarizeDiff, type ThreadItem } from './thread.ts';

const MAX_FILES = 12;

function Header({ item }: Readonly<{ item: Extract<ThreadItem, { kind: 'header' }> }>) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tone('cyan')} paddingX={1}>
      <Text>
        <Text bold color={tone('cyan')}>
          AI Duo
        </Text>
        <Text dimColor>{` v${item.version} · Claude × Codex`}</Text>
      </Text>
      <Text dimColor>
        {item.cwd}
        {item.branch ? ` · ⎇ ${item.branch}` : ''}
      </Text>
      <Text dimColor>/help for commands · Tab picks a role · Shift+Tab switches Code/Plan · ! runs a shell command</Text>
    </Box>
  );
}

function FileList({ files, width }: Readonly<{ files: string[]; width: number }>) {
  const shown = files.slice(0, MAX_FILES);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {shown.map((file) => (
        <Text key={file} dimColor>{`• ${oneLine(file, width - 6)}`}</Text>
      ))}
      {files.length > shown.length ? <Text dimColor>{`… and ${files.length - shown.length} more`}</Text> : null}
    </Box>
  );
}

const STATUS_MARK: Record<Run['status'], { mark: string; label: string; color: 'green' | 'red' | 'yellow' | 'cyan' }> = {
  done: { mark: '✓', label: 'done', color: 'green' },
  error: { mark: '✗', label: 'failed', color: 'red' },
  cancelled: { mark: '■', label: 'cancelled', color: 'yellow' },
  running: { mark: '…', label: 'running', color: 'cyan' },
};

/** End of a turn: status, files changed, usage and the run id to continue from another shell. */
export function RunSummary({ run, width }: Readonly<{ run: Run; width: number }>) {
  const status = STATUS_MARK[run.status];
  const diff = summarizeDiff(run.diff);
  const usage = formatUsageLine(run.usage);
  const changed = diff.files.length ? ` · ${diff.files.length} file(s) changed (+${diff.added} −${diff.removed}), not committed` : '';
  const usageSuffix = usage ? ` · ${usage}` : '';
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text bold color={tone(status.color)}>{`${status.mark} ${status.label}`}</Text>
        <Text dimColor>{`${changed}${usageSuffix}`}</Text>
      </Text>
      {run.error ? <Text color={tone('red')}>{run.error}</Text> : null}
      <FileList files={diff.files} width={width} />
      <Text dimColor>{`run ${run.id}`}</Text>
    </Box>
  );
}

const NOTICE_MARK = { info: 'ℹ', warn: '!', error: '✗' } as const;
const NOTICE_TONE = { info: 'cyan', warn: 'yellow', error: 'red' } as const;

interface ItemViewProps {
  item: ThreadItem;
  width: number;
  /** Shell output: show only the newest lines (the live block). */
  maxLines?: number;
}

export const ThreadItemView = memo(function ThreadItemView({ item, width, maxLines }: Readonly<ItemViewProps>) {
  switch (item.kind) {
    case 'header':
      return <Header item={item} />;
    case 'user':
      return <UserLine text={item.text} />;
    case 'message':
      return <MessageView message={item.message} width={width} effort={item.effort} />;
    case 'summary':
      return <RunSummary run={item.run} width={width} />;
    case 'shell':
      return <ShellBlock item={item} maxLines={maxLines} />;
    default:
      return (
        <Box marginTop={1}>
          <Text color={tone(NOTICE_TONE[item.tone])}>{`${NOTICE_MARK[item.tone]} ${item.text}`}</Text>
        </Box>
      );
  }
});

/** Finished items of the full-screen thread; memoized rows, so only new items are laid out again. */
export const FinishedThread = memo(function FinishedThread({ items, hidden, width }: Readonly<{ items: readonly ThreadItem[]; hidden: number; width: number }>) {
  return (
    <Box flexDirection="column">
      {hidden > 0 ? <Text dimColor>{`… ${hidden} earlier item(s) not shown · ai-duo show <run-id> prints the whole run`}</Text> : null}
      {items.map((item) => (
        <ThreadItemView key={item.id} item={item} width={width} />
      ))}
    </Box>
  );
});

interface FullscreenHeaderProps {
  version: string;
  cwd: string;
  branch?: string;
  /** One line only (very short terminals). */
  compact: boolean;
}

/** Fixed top bar of the full-screen chat: 1-2 lines, truncated to the terminal width. */
export function FullscreenHeader({ version, cwd, branch, compact }: Readonly<FullscreenHeaderProps>) {
  const suffix = branch ? ` · ⎇ ${branch}` : '';
  const where = cwd + suffix;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text wrap="truncate-end">
        <Text bold color={tone('cyan')}>
          AI Duo
        </Text>
        <Text dimColor>{` v${version} · Claude × Codex`}</Text>
        {compact ? <Text dimColor>{` · ${where}`}</Text> : null}
      </Text>
      {compact ? null : (
        <Text wrap="truncate-end" dimColor>
          {where}
        </Text>
      )}
    </Box>
  );
}

interface LiveThreadProps {
  run: Run | null;
  messages: readonly Message[];
  width: number;
  /** Terminal rows; bounds how much of a streaming answer is shown. */
  rows: number;
}

/** The messages still being written; they move into the printed thread when they finish. */
export function LiveThread({ run, messages, width, rows }: Readonly<LiveThreadProps>) {
  if (messages.length === 0) return null;
  const liveLines = Math.max(4, rows - 14);
  return (
    <Box flexDirection="column">
      {messages.map((message) => (
        <MessageView key={message.id} message={message} width={width} live liveLines={liveLines} effort={run ? effortFor(run, message) : undefined} />
      ))}
    </Box>
  );
}

/** Most finished items the full-screen thread lays out; older ones are dropped in blocks of WINDOW_STEP. */
export const WINDOW_MAX = 400;
export const WINDOW_STEP = 100;

/** The header is a fixed bar in full screen; a long log is cut from the front, in blocks (so the cut rarely moves). */
export function windowLog(log: readonly ThreadItem[]): { items: ThreadItem[]; hidden: number } {
  const body = log.filter((item) => item.kind !== 'header');
  if (body.length <= WINDOW_MAX) return { items: body, hidden: 0 };
  const hidden = Math.floor((body.length - WINDOW_MAX) / WINDOW_STEP + 1) * WINDOW_STEP;
  return { items: body.slice(hidden), hidden };
}
