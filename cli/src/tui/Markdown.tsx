import { Box, Text } from 'ink';
import { tone } from './theme.ts';

/** Markdown-lite: fences, headings, lists, quotes, **bold** and `code`. Everything else is plain text. */

export interface Span {
  id: number;
  kind: 'plain' | 'bold' | 'code';
  text: string;
}

type SpanMatch = { kind: 'bold' | 'code'; text: string; end: number };

function matchSpan(line: string, at: number): SpanMatch | undefined {
  if (line[at] === '`') {
    const end = line.indexOf('`', at + 1);
    if (end > at + 1) return { kind: 'code', text: line.slice(at + 1, end), end: end + 1 };
  } else if (line.startsWith('**', at)) {
    const end = line.indexOf('**', at + 2);
    if (end > at + 2) return { kind: 'bold', text: line.slice(at + 2, end), end: end + 2 };
  }
  return undefined;
}

export function parseInline(line: string): Span[] {
  const spans: Span[] = [];
  let plain = '';
  const flush = () => {
    if (plain) spans.push({ id: spans.length, kind: 'plain', text: plain });
    plain = '';
  };
  let at = 0;
  while (at < line.length) {
    const found = matchSpan(line, at);
    if (found) {
      flush();
      spans.push({ id: spans.length, kind: found.kind, text: found.text });
      at = found.end;
    } else {
      plain += line[at];
      at++;
    }
  }
  flush();
  return spans;
}

export type Block =
  | { id: number; type: 'code'; lang: string; lines: string[] }
  | { id: number; type: 'heading'; text: string }
  | { id: number; type: 'item'; marker: string; indent: number; text: string }
  | { id: number; type: 'quote'; text: string }
  | { id: number; type: 'text'; text: string };

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** "- x", "* x", "+ x", "1. x" or "1) x" -> marker and text. */
function listMarker(trimmed: string): { marker: string; text: string } | undefined {
  if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('+ ')) return { marker: '•', text: trimmed.slice(2) };
  let digits = 0;
  while (isDigit(trimmed[digits])) digits++;
  if (digits > 0 && digits < 4 && (trimmed[digits] === '.' || trimmed[digits] === ')') && trimmed[digits + 1] === ' ') {
    return { marker: `${trimmed.slice(0, digits)}.`, text: trimmed.slice(digits + 2) };
  }
  return undefined;
}

function headingText(trimmed: string): string | undefined {
  let hashes = 0;
  while (trimmed[hashes] === '#') hashes++;
  return hashes > 0 && hashes <= 6 && trimmed[hashes] === ' ' ? trimmed.slice(hashes + 1) : undefined;
}

function lineBlock(id: number, line: string): Block {
  const trimmed = line.trimStart();
  const heading = headingText(trimmed);
  if (heading !== undefined) return { id, type: 'heading', text: heading };
  const item = listMarker(trimmed);
  if (item) return { id, type: 'item', marker: item.marker, indent: Math.min(6, line.length - trimmed.length), text: item.text };
  if (trimmed.startsWith('> ')) return { id, type: 'quote', text: trimmed.slice(2) };
  return { id, type: 'text', text: line };
}

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let fence: { lang: string; lines: string[] } | undefined;
  for (const line of source.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (fence) {
        blocks.push({ id: blocks.length, type: 'code', ...fence });
        fence = undefined;
      } else {
        fence = { lang: line.trim().slice(3).trim(), lines: [] };
      }
    } else if (fence) {
      fence.lines.push(line);
    } else {
      blocks.push(lineBlock(blocks.length, line));
    }
  }
  if (fence) blocks.push({ id: blocks.length, type: 'code', ...fence });
  return blocks;
}

function Inline({ text }: Readonly<{ text: string }>) {
  return (
    <>
      {parseInline(text).map((span) => (
        <Text key={span.id} bold={span.kind === 'bold'} color={span.kind === 'code' ? tone('cyan') : undefined}>
          {span.text}
        </Text>
      ))}
    </>
  );
}

function BlockView({ block }: Readonly<{ block: Block }>) {
  switch (block.type) {
    case 'code':
      return (
        <Box flexDirection="column" paddingLeft={2}>
          {block.lang ? <Text dimColor>{block.lang}</Text> : null}
          {block.lines.map((line, row) => (
            <Text key={`${block.id}:${row}`} color={tone('cyan')}>
              {line || ' '}
            </Text>
          ))}
        </Box>
      );
    case 'heading':
      return (
        <Text bold underline>
          <Inline text={block.text} />
        </Text>
      );
    case 'item':
      return (
        <Box paddingLeft={block.indent}>
          <Text dimColor>{block.marker} </Text>
          <Box flexShrink={1}>
            <Text>
              <Inline text={block.text} />
            </Text>
          </Box>
        </Box>
      );
    case 'quote':
      return (
        <Text dimColor>
          {'│ '}
          <Inline text={block.text} />
        </Text>
      );
    default:
      return (
        <Text>
          <Inline text={block.text} />
        </Text>
      );
  }
}

export function Markdown({ text }: Readonly<{ text: string }>) {
  const blocks = parseBlocks(text.replaceAll('\r\n', '\n').trimEnd());
  return (
    <Box flexDirection="column">
      {blocks.map((block) => (
        <BlockView key={block.id} block={block} />
      ))}
    </Box>
  );
}
