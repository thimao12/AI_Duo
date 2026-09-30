import { Box, Text } from 'ink';
import type { Message, Run } from '../../../server/src/types.ts';
import { MessageView, UserLine } from './MessageView.tsx';
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
      <Text dimColor>/help for commands · Tab picks a role · Shift+Tab switches Code/Plan</Text>
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

export function ThreadItemView({ item, width }: Readonly<{ item: ThreadItem; width: number }>) {
  switch (item.kind) {
    case 'header':
      return <Header item={item} />;
    case 'user':
      return <UserLine text={item.text} />;
    case 'message':
      return <MessageView message={item.message} width={width} effort={item.effort} />;
    case 'summary':
      return <RunSummary run={item.run} width={width} />;
    default:
      return (
        <Box marginTop={1}>
          <Text color={tone(NOTICE_TONE[item.tone])}>{`${NOTICE_MARK[item.tone]} ${item.text}`}</Text>
        </Box>
      );
  }
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
