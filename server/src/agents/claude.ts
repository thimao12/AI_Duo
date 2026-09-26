import { resolveBin } from './bins.ts';
import { spawnJsonl } from './process.ts';
import type { AgentAdapter, Role, RunOptions, RunResult } from './types.ts';

function permissionArgs(role: Role): string[] {
  switch (role) {
    case 'coder':
      return ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Edit,Write,Read,Grep,Glob,TodoWrite'];
    case 'reviewer':
      return ['--allowedTools', 'Bash,Read,Grep,Glob', '--disallowedTools', 'Edit,Write,NotebookEdit'];
    case 'thinker':
    default:
      return ['--allowedTools', 'Read,Grep,Glob,WebSearch,WebFetch', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit'];
  }
}

function summarizeInput(input: any): string {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  const s = JSON.stringify(input);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

function toolResultText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  return '';
}

export const claude: AgentAdapter = {
  name: 'claude',
  async run(o: RunOptions): Promise<RunResult> {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...permissionArgs(o.role)];
    if (o.model) args.push('--model', o.model);
    if (o.sessionId) args.push('--resume', o.sessionId);

    let sessionId = o.sessionId;
    let finalText: string | undefined;
    let streamed = '';
    let errorText: string | undefined;

    const { code, stderr } = await spawnJsonl(resolveBin('claude'), args, {
      cwd: o.cwd,
      stdin: o.prompt,
      signal: o.signal,
      timeoutMs: o.timeoutMs ?? 10 * 60_000,
      onRawLine: (line) => o.onEvent({ kind: 'raw', content: line }),
      onJson: (ev) => {
        if (ev.session_id) sessionId = ev.session_id;
        const topLevel = !ev.parent_tool_use_id;

        if (ev.type === 'stream_event' && topLevel) {
          const d = ev.event?.delta;
          if (ev.event?.type === 'content_block_delta' && d?.type === 'text_delta' && d.text) {
            streamed += d.text;
            o.onEvent({ kind: 'text_delta', content: d.text });
          } else if (ev.event?.type === 'content_block_start' && ev.event.content_block?.type === 'text' && streamed) {
            // new text block after a tool call: keep blocks visually separated
            streamed += '\n\n';
            o.onEvent({ kind: 'text_delta', content: '\n\n' });
          }
        } else if (ev.type === 'assistant') {
          for (const block of ev.message?.content ?? []) {
            if (block.type === 'tool_use') {
              o.onEvent({ kind: 'tool', content: `${block.name}: ${summarizeInput(block.input)}` });
            }
          }
        } else if (ev.type === 'user' && topLevel) {
          for (const block of ev.message?.content ?? []) {
            if (block?.type === 'tool_result') {
              const text = toolResultText(block.content);
              if (text) o.onEvent({ kind: 'tool_result', content: text.length > 4000 ? text.slice(0, 4000) + '\n…' : text });
            }
          }
        } else if (ev.type === 'result') {
          if (ev.is_error) errorText = typeof ev.result === 'string' ? ev.result : `Claude error (${ev.subtype})`;
          else if (typeof ev.result === 'string') finalText = ev.result;
        }
        // system / rate_limit_event / other: ignored on purpose
      },
    });

    if (errorText) throw new Error(errorText);
    if (finalText === undefined) {
      if (code !== 0) throw new Error(`claude exited with code ${code}: ${stderr.trim().slice(-1500)}`);
      finalText = streamed;
    }
    return { finalText, sessionId };
  },
};
