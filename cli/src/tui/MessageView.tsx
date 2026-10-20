import { Box, Text } from 'ink';
import type { EditInfo } from '../../../server/src/agents/types.ts';
import type { Message, Part } from '../../../server/src/types.ts';
import { countChanges, diffTexts } from './diff.ts';
import { DiffView } from './DiffView.tsx';
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
  /** File edits: what changed. */
  edit?: EditInfo;
  /** Shell and MCP calls: the output that came back. */
  output?: string;
}

/** Tools whose output is worth showing under the call; file reads would only add noise. */
const SHOWS_OUTPUT = /^(Bash|Shell|MCP|PowerShell|Ran|run_command)\b/i;

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
    if (part.kind === 'tool_result') {
      const call = items.at(-1);
      if (call?.kind === 'tool' && SHOWS_OUTPUT.test(call.text) && part.content.trim()) call.output = part.content;
      return;
    }
    if (part.kind === 'tool') items.push({ id: items.length, kind: 'tool', text: part.content, pending: running && index === parts.length - 1, ...(part.edit && { edit: part.edit }) });
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

const OUTPUT_LINES = 8;

/** Codex reports "exit N" on the first line of a command's output. */
function splitExit(output: string): { code?: number; body: string } {
  const match = /^exit (\d+)\r?\n?/.exec(output);
  return match ? { code: Number(match[1]), body: output.slice(match[0].length) } : { body: output };
}

function ToolOutput({ output, width }: Readonly<{ output: string; width: number }>) {
  const { code, body } = splitExit(output);
  const lines = body.replace(/\s+$/, '').split('\n');
  const shown = lines.slice(0, OUTPUT_LINES);
  return (
    <Box flexDirection="column" paddingLeft={4}>
      {shown.map((line, i) => (
        <Text key={i} dimColor>{`│ ${oneLine(line, width - 10)}`}</Text>
      ))}
      {lines.length > shown.length ? <Text dimColor>{`│ … ${lines.length - shown.length} more line(s)`}</Text> : null}
      {code !== undefined ? <Text color={tone(code === 0 ? 'green' : 'red')}>{code === 0 ? '└ exit 0' : `└ exit ${code}`}</Text> : null}
    </Box>
  );
}

function EditBlock({ edit, width }: Readonly<{ edit: EditInfo; width: number }>) {
  const lines = diffTexts(edit.oldText, edit.newText);
  const { added, removed } = countChanges(lines);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        {'  '}
        <Text bold>{edit.path}</Text>
        <Text color={tone('green')}>{` +${added}`}</Text>
        <Text color={tone('red')}>{` −${removed}`}</Text>
      </Text>
      <DiffView lines={lines} width={width - 2} maxRows={24} />
    </Box>
  );
}

function formatFileTarget(target: string): string {
  const clean = target.trim();
  if (/^\d+\s+files?\b/i.test(clean)) return clean;
  const stripped = clean.replace(/^[("']+|[)"']+$/g, '');
  const files = stripped.split(',').map((s) => s.trim()).filter(Boolean);
  if (files.length > 1) {
    const basenames = files.map((f) => f.split(/[/\\]/).filter(Boolean).pop() ?? f).join(', ');
    return `${files.length} files (${basenames})`;
  }
  const base = stripped.split(/[/\\]/).filter(Boolean).pop() ?? stripped;
  return `1 file (${base})`;
}

function formatTaskTarget(target: string): string {
  const clean = target.trim();
  if (/^\d+\s+tasks?\b/i.test(clean)) return clean;
  const stripped = clean.replace(/^[("']+|[)"']+$/g, '');
  return `1 task (${stripped})`;
}

export function formatToolCall(text: string, edit?: EditInfo): { verb: string; detail: string } {
  const trimmed = text.trim();

  if (edit?.path) {
    return { verb: 'Edited', detail: formatFileTarget(edit.path) };
  }

  const knownMatch = /^(Ran|Checked|Explored|Edited|Searched)\s+(.+)$/s.exec(trimmed);
  if (knownMatch) {
    return { verb: knownMatch[1], detail: knownMatch[2].trim() };
  }

  const shellMatch = /^(?:Bash|Shell|PowerShell):\s*(.+)$/s.exec(trimmed);
  if (shellMatch) {
    const cmd = shellMatch[1].trim();
    return { verb: 'Ran', detail: cmd.startsWith('(') && cmd.endsWith(')') ? cmd : `(${cmd})` };
  }

  if (/^run_command\b/i.test(trimmed)) {
    try {
      const jsonStr = trimmed.slice(trimmed.indexOf('{'));
      const parsed = JSON.parse(jsonStr);
      const cmd = parsed.CommandLine ?? parsed.command ?? parsed.cmd ?? '';
      if (cmd) return { verb: 'Ran', detail: `(${cmd})` };
    } catch {}
    const remainder = trimmed.replace(/^run_command\s*/i, '').trim();
    return { verb: 'Ran', detail: remainder ? `(${remainder})` : '' };
  }

  const editMatch = /^(?:Edit|Write):\s*(.+)$/s.exec(trimmed);
  if (editMatch) {
    return { verb: 'Edited', detail: formatFileTarget(editMatch[1]) };
  }

  if (/^(?:replace_file_content|write_to_file)\b/i.test(trimmed)) {
    try {
      const jsonStr = trimmed.slice(trimmed.indexOf('{'));
      const parsed = JSON.parse(jsonStr);
      const file = parsed.TargetFile ?? parsed.file_path ?? parsed.path ?? '';
      if (file) return { verb: 'Edited', detail: formatFileTarget(file) };
    } catch {}
    return { verb: 'Edited', detail: '1 file' };
  }

  const readMatch = /^(?:Read|Glob):\s*(.+)$/s.exec(trimmed);
  if (readMatch) {
    const target = readMatch[1].trim();
    return { verb: 'Explored', detail: target.includes('*') ? `(${target})` : formatFileTarget(target) };
  }

  if (/^(?:view_file|list_dir|find_files)\b/i.test(trimmed)) {
    try {
      const jsonStr = trimmed.slice(trimmed.indexOf('{'));
      const parsed = JSON.parse(jsonStr);
      const file = parsed.AbsolutePath ?? parsed.TargetFile ?? parsed.path ?? '';
      if (file) return { verb: 'Explored', detail: formatFileTarget(file) };
    } catch {}
    return { verb: 'Explored', detail: '1 file' };
  }

  if (/^manage_task\b/i.test(trimmed)) {
    try {
      const jsonStr = trimmed.slice(trimmed.indexOf('{'));
      const parsed = JSON.parse(jsonStr);
      const taskId = parsed.TaskId ?? parsed.taskId ?? parsed.id ?? '';
      if (taskId) return { verb: 'Checked', detail: formatTaskTarget(taskId) };
    } catch {}
    return { verb: 'Checked', detail: '1 task' };
  }

  const searchMatch = /^(?:Grep|WebSearch|WebFetch):\s*(.+)$/s.exec(trimmed);
  if (searchMatch) {
    const q = searchMatch[1].trim();
    return { verb: 'Searched', detail: q.startsWith('(') && q.endsWith(')') ? q : `(${q})` };
  }

  if (/^search_web\b/i.test(trimmed)) {
    try {
      const jsonStr = trimmed.slice(trimmed.indexOf('{'));
      const parsed = JSON.parse(jsonStr);
      const q = parsed.query ?? '';
      if (q) return { verb: 'Searched', detail: `(${q})` };
    } catch {}
    return { verb: 'Searched', detail: '' };
  }

  const colonMatch = /^([^:]+):\s*(.+)$/s.exec(trimmed);
  if (colonMatch) {
    return { verb: 'Ran', detail: `(${colonMatch[1]}: ${colonMatch[2].trim()})` };
  }

  return { verb: 'Ran', detail: trimmed.startsWith('(') && trimmed.endsWith(')') ? trimmed : `(${trimmed})` };
}

function renderDetail(detail: string, maxLen: number) {
  const trimmed = detail.trim();
  const compound = /^(\d+\s+commands?),\s*(checked)\s+(.+)$/i.exec(trimmed);
  if (compound) {
    const [, cmds, chk, rest] = compound;
    const taskMatch = /^(\d+\s+tasks?)\s*(.*)$/i.exec(rest);
    if (taskMatch) {
      const [, tasks, parens] = taskMatch;
      return (
        <Text>
          <Text>{` ${cmds}, `}</Text>
          <Text bold color={tone('yellow')}>{chk}</Text>
          <Text>{` ${tasks}`}</Text>
          {parens ? <Text dimColor>{` ${oneLine(parens, Math.max(6, maxLen - cmds.length - chk.length - tasks.length - 4))}`}</Text> : null}
        </Text>
      );
    }
    return (
      <Text>
        <Text>{` ${cmds}, `}</Text>
        <Text bold color={tone('yellow')}>{chk}</Text>
        <Text dimColor>{` ${oneLine(rest, Math.max(6, maxLen - cmds.length - chk.length - 4))}`}</Text>
      </Text>
    );
  }

  const countMatch = /^(\d+\s+(?:files?|tasks?|commands?))\s*(.*)$/i.exec(trimmed);
  if (countMatch) {
    const [, count, parens] = countMatch;
    return (
      <Text>
        <Text>{` ${count}`}</Text>
        {parens ? <Text dimColor>{` ${oneLine(parens, Math.max(6, maxLen - count.length - 1))}`}</Text> : null}
      </Text>
    );
  }

  return <Text dimColor>{` ${oneLine(trimmed, maxLen)}`}</Text>;
}

function ToolLine({ item, width }: Readonly<{ item: PartItem; width: number }>) {
  const { verb, detail } = formatToolCall(item.text, item.edit);
  const mark = item.pending ? <Spinner /> : <Text color={tone('blue') ?? tone('cyan')}>●</Text>;

  return (
    <Box flexDirection="column">
      <Box>
        <Text>  </Text>
        {mark}
        <Text> </Text>
        <Text bold color={tone('yellow')}>
          {verb}
        </Text>
        {detail ? renderDetail(detail, Math.max(10, width - 8 - verb.length)) : null}
      </Box>
      {item.edit ? <EditBlock edit={item.edit} width={width} /> : null}
      {item.output ? <ToolOutput output={item.output} width={width} /> : null}
    </Box>
  );
}

function ReasoningLine({ item, width }: Readonly<{ item: PartItem; width: number }>) {
  let display = item.text;
  if (display.startsWith('reasoning · ')) {
    display = `Thought (${display.slice(12)})`;
  } else if (!/^thought\b/i.test(display)) {
    display = `Thought (${display})`;
  }
  const match = /^(Thought(?:\s+for\s+[\d.]+s)?)\s*(.*)$/i.exec(display);
  return (
    <Box>
      <Text>  </Text>
      <Text color={tone('gray')}>○ </Text>
      {match ? (
        <Text italic>
          <Text color={tone('gray')}>{match[1]}</Text>
          {match[2] ? <Text dimColor color={tone('gray')}>{` ${oneLine(match[2], Math.max(6, width - 8 - match[1].length))}`}</Text> : null}
        </Text>
      ) : (
        <Text italic dimColor color={tone('gray')}>
          {oneLine(display, Math.max(10, width - 6))}
        </Text>
      )}
    </Box>
  );
}

function PartLine({ item, width }: Readonly<{ item: PartItem; width: number }>) {
  switch (item.kind) {
    case 'text':
      return <Markdown text={item.text} />;
    case 'tool':
      return <ToolLine item={item} width={width} />;
    case 'reasoning':
      return <ReasoningLine item={item} width={width} />;
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
