import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveBin } from './bins.ts';
import { spawnJsonl } from './process.ts';
import type { AgentAdapter, Role, RunOptions, RunResult } from './types.ts';

function sandboxFor(role: Role): 'read-only' | 'workspace-write' {
  return role === 'thinker' ? 'read-only' : 'workspace-write';
}

export const codex: AgentAdapter = {
  name: 'codex',
  async run(o: RunOptions): Promise<RunResult> {
    const dir = await mkdtemp(path.join(tmpdir(), 'ai-duo-codex-'));
    const lastFile = path.join(dir, 'last.txt');
    const sandbox = sandboxFor(o.role);

    // `exec resume` accepts neither -C nor -s, so sandbox goes through -c and cwd through spawn.
    const args = o.sessionId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`, '-o', lastFile]
      : ['exec', '--json', '--skip-git-repo-check', '-C', o.cwd, '-s', sandbox, '-o', lastFile];
    if (o.model) args.push('-m', o.model);
    if (o.sessionId) args.push(o.sessionId);
    args.push('-'); // prompt from stdin

    let sessionId = o.sessionId;
    const messages: string[] = [];
    let errorText: string | undefined;

    try {
      const { code, stderr } = await spawnJsonl(resolveBin('codex'), args, {
        cwd: o.cwd,
        stdin: o.prompt,
        signal: o.signal,
        timeoutMs: o.timeoutMs ?? 10 * 60_000,
        onRawLine: (line) => o.onEvent({ kind: 'raw', content: line }),
        onJson: (ev) => {
          const item = ev.item;
          switch (ev.type) {
            case 'thread.started':
              sessionId = ev.thread_id;
              break;
            case 'item.started':
              if (item?.type === 'command_execution') o.onEvent({ kind: 'tool', content: `Shell: ${item.command}` });
              else if (item?.type === 'mcp_tool_call') o.onEvent({ kind: 'tool', content: `MCP: ${item.server}/${item.tool}` });
              else if (item?.type === 'web_search') o.onEvent({ kind: 'tool', content: `WebSearch: ${item.query ?? ''}` });
              break;
            case 'item.completed':
              if (item?.type === 'agent_message' && item.text) {
                messages.push(item.text);
                o.onEvent({ kind: 'text', content: item.text });
              } else if (item?.type === 'command_execution') {
                const out = String(item.aggregated_output ?? '');
                o.onEvent({
                  kind: 'tool_result',
                  content: `exit ${item.exit_code ?? '?'}\n${out.length > 4000 ? out.slice(0, 4000) + '\n…' : out}`,
                });
              } else if (item?.type === 'file_change') {
                const changes = (item.changes ?? []).map((c: any) => `${c.kind ?? 'edit'} ${c.path}`).join('\n');
                o.onEvent({ kind: 'tool', content: `Edit files:\n${changes}` });
              } else if (item?.type === 'error') {
                o.onEvent({ kind: 'error', content: item.message ?? 'error' });
              }
              break;
            case 'turn.failed':
              errorText = ev.error?.message ?? 'Codex turn failed';
              break;
            case 'error':
              errorText = ev.message ?? 'Codex error';
              break;
          }
        },
      });

      if (errorText) throw new Error(errorText);
      let finalText = await readFile(lastFile, 'utf8').catch(() => '');
      if (!finalText) finalText = messages.join('\n\n');
      if (!finalText && code !== 0) throw new Error(`codex exited with code ${code}: ${stderr.trim().slice(-1500)}`);
      return { finalText, sessionId };
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
};
