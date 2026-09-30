import { Box, Text } from 'ink';
import type { Message, Part } from '../../../server/src/types.ts';
import { Markdown } from './Markdown.tsx';
import { Spinner } from './Spinner.tsx';
import { SPEAKER_NAME, speakerTone, tone } from './theme.ts';
import { clipLines, formatDuration, formatUsageLine, oneLine, tailLines } from './thread.ts';

export interface PartItem {
  id: number;
  kind: 'text' | 'tool' | 'error' | 'reasoning';
  text: string;
  /** Tool calls: still waiting for their result. */
  pending?: boolean;
}

/** Fold raw message parts into what is worth showing: text, one line per tool call, one line for reasoning. */
export function toPartItems(parts: readonly Part[], running: boolean): PartItem[] {
  const items: PartItem[] = [];
  let rawLines = 0;
  const flushReasoning = () => {
    if (rawLines > 0) items.push({ id: items.length, kind: 'reasoning', text: `reasoning · ${rawLines} line${rawLines === 1 ? '' : 's'}` });
    rawLines = 0;
  };
  parts.forEach((part, index) => {
    if (part.kind === 'raw') {
      if (part.content && !part.content.startsWith('{')) rawLines++;
      return;
    }
    flushReasoning();
    if (part.kind === 'tool_result') return;
    if (part.kind === 'tool') items.push({ id: items.length, kind: 'tool', text: part.content, pending: running && index === parts.length - 1 });
    else if (part.content.trim()) items.push({ id: items.length, kind: part.kind, text: part.content });
  });
  flushReasoning();
  return items;
}

function Heading({ message, effort }: Readonly<{ message: Message; effort?: string }>) {
  const meta = [message.model, effort].filter(Boolean).join(' · ');
  return (
    <Text>
      <Text bold color={speakerTone(message.agent)}>
        {'▸ '}
        {message.title}
      </Text>
      {meta ? <Text dimColor>{` · ${meta}`}</Text> : null}
      {message.status === 'error' ? <Text color={tone('red')}> ✗</Text> : null}
    </Text>
  );
}

function VerdictBadge({ verdict }: Readonly<{ verdict?: string }>) {
  if (!verdict) return null;
  const good = verdict === 'APPROVE' || verdict === 'AGREE';
  return (
    <Text bold color={tone(good ? 'green' : 'yellow')}>
      {` [${verdict}]`}
    </Text>
  );
}

function Footer({ message }: Readonly<{ message: Message }>) {
  if (message.status === 'running') return null;
  const ok = message.status === 'done';
  const took = message.endedAt ? ` · ${formatDuration(message.endedAt - message.startedAt)}` : '';
  const usage = message.usage ? ` · ${formatUsageLine(message.usage)}` : '';
  return (
    <Text dimColor>
      <Text color={tone(ok ? 'green' : 'red')}>{ok ? '✓' : '✗'}</Text>
      {` ${SPEAKER_NAME[message.agent]}${took}${usage}`}
      <VerdictBadge verdict={message.verdict} />
    </Text>
  );
}

function PartLine({ item, width }: Readonly<{ item: PartItem; width: number }>) {
  switch (item.kind) {
    case 'text':
      return <Markdown text={item.text} />;
    case 'tool':
      return (
        <Text dimColor>
          {`  $ ${oneLine(item.text, width - 8)} `}
          {item.pending ? <Spinner /> : <Text color={tone('green')}>✓</Text>}
        </Text>
      );
    case 'error':
      return <Text color={tone('red')}>{`  ✗ ${oneLine(item.text, width - 6)}`}</Text>;
    default:
      return <Text dimColor>{`  ∴ ${item.text}`}</Text>;
  }
}

const MAX_LIVE_ITEMS = 6;

interface MessageViewProps {
  message: Message;
  width: number;
  effort?: string;
  /** Still streaming: only the tail of the text is shown so the terminal is never overrun. */
  live?: boolean;
  liveLines?: number;
}

function AgentMessage({ message, width, effort, live, liveLines = 12 }: Readonly<MessageViewProps>) {
  const running = message.status === 'running';
  const all = toPartItems(message.parts, running);
  const items = live ? all.slice(-MAX_LIVE_ITEMS) : all;
  const lastText = live ? items.findLast((i) => i.kind === 'text') : undefined;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Heading message={message} effort={effort} />
      {live && all.length > items.length ? <Text dimColor>{`  … ${all.length - items.length} earlier step(s)`}</Text> : null}
      {items.map((item) => {
        if (item !== lastText) return <PartLine key={item.id} item={item} width={width} />;
        const tail = tailLines(item.text, liveLines);
        return (
          <Box key={item.id} flexDirection="column">
            {tail.hidden > 0 ? <Text dimColor>{`  … ${tail.hidden} earlier line(s)`}</Text> : null}
            <PartLine item={{ ...item, text: tail.text }} width={width} />
          </Box>
        );
      })}
      {running && items.length === 0 ? (
        <Text dimColor>
          <Spinner /> thinking…
        </Text>
      ) : null}
      <Footer message={message} />
    </Box>
  );
}

function SystemMessage({ message }: Readonly<{ message: Message }>) {
  const body = message.parts.find((p) => p.kind === 'text')?.content ?? '';
  const clipped = clipLines(body, 6);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={tone('cyan')}>
        {'ℹ '}
        <Text bold>{message.title}</Text>
      </Text>
      {body ? <Text dimColor>{clipped.text.split('\n').map((l) => `  ${l}`).join('\n')}</Text> : null}
      {clipped.hidden > 0 ? <Text dimColor>{`  … ${clipped.hidden} more line(s)`}</Text> : null}
    </Box>
  );
}

export function MessageView(props: Readonly<MessageViewProps>) {
  const { message } = props;
  if (message.agent === 'system') return <SystemMessage message={message} />;
  if (message.agent === 'user') return <UserLine text={message.parts[0]?.content ?? ''} />;
  return <AgentMessage {...props} />;
}

export function UserLine({ text }: Readonly<{ text: string }>) {
  return (
    <Box marginTop={1}>
      <Text bold color={tone('magenta')}>
        {'› '}
      </Text>
      <Box flexShrink={1}>
        <Text>{text}</Text>
      </Box>
    </Box>
  );
}
