import { useState } from 'react';
import { Box, Text } from 'ink';
import { getCliSettings, setCliSettings } from '../../../../server/src/settings.ts';
import type { CliSettings, McpServer } from '../../../../server/src/types.ts';
import type { PanelProps } from '../panel-types.ts';
import { errorText } from '../theme.ts';
import { useLoader } from '../util.ts';
import Confirm from '../widgets/Confirm.tsx';
import Form, { type FormField } from '../widgets/Form.tsx';
import Panel from '../widgets/Panel.tsx';
import SelectList from '../widgets/SelectList.tsx';

/** A server as typed in the form: arguments and variables are plain text, roles one of a few combinations. */
export interface McpDraft {
  name: string;
  command: string;
  args: string;
  env: string;
  roles: string;
}

/** Which roles may use a server, as the form's choices (the default is the coder only). */
export const ROLE_CHOICES: Record<string, McpServer['roles']> = {
  coder: ['coder'],
  'coder + reviewer': ['coder', 'reviewer'],
  'tất cả': ['coder', 'reviewer', 'thinker'],
  reviewer: ['reviewer'],
};

const choiceOf = (roles: McpServer['roles']): string => {
  const key = JSON.stringify([...(roles ?? ['coder'])].sort());
  return Object.keys(ROLE_CHOICES).find((k) => JSON.stringify([...(ROLE_CHOICES[k] ?? [])].sort()) === key) ?? 'coder';
};

/** Arguments split on spaces; a double-quoted part (also inside a word, as in `KEY="a b"`) keeps its spaces. */
export function parseArgs(text: string): string[] {
  return (text.match(/(?:[^\s"]|"[^"]*")+/g) ?? []).map((part) => part.replaceAll('"', ''));
}

/** `KEY=value KEY2="two words"` as a record; parts without `=` are ignored. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const part of parseArgs(text)) {
    const at = part.indexOf('=');
    if (at > 0) env[part.slice(0, at)] = part.slice(at + 1);
  }
  return env;
}

const quote = (value: string) => (/\s/.test(value) ? `"${value}"` : value);

export const draftOf = (server: McpServer): McpDraft => ({
  name: server.name,
  command: server.command,
  args: (server.args ?? []).map(quote).join(' '),
  env: Object.entries(server.env ?? {}).map(([k, v]) => `${k}=${quote(v)}`).join(' '),
  roles: choiceOf(server.roles),
});

export function serverOf(draft: McpDraft): McpServer {
  const args = parseArgs(draft.args);
  const env = parseEnv(draft.env);
  return {
    name: draft.name.trim(),
    command: draft.command.trim(),
    ...(args.length && { args }),
    ...(Object.keys(env).length && { env }),
    ...(draft.roles !== 'coder' && { roles: ROLE_CHOICES[draft.roles] }),
  };
}

export function mcpFields(draft: McpDraft): FormField[] {
  return [
    { id: 'name', label: 'Tên', kind: 'text', value: draft.name, hint: 'Chữ, số, _ hoặc -. Tool của server có tiền tố mcp__<tên>.' },
    { id: 'command', label: 'Lệnh', kind: 'text', value: draft.command, placeholder: 'npx', hint: 'File chạy của MCP server (stdio).' },
    { id: 'args', label: 'Tham số', kind: 'text', value: draft.args, placeholder: '-y @scope/server', hint: 'Cách nhau bằng dấu cách; đặt trong "…" nếu có dấu cách.' },
    { id: 'env', label: 'Biến môi trường', kind: 'text', value: draft.env, placeholder: 'TOKEN=abc', hint: 'KEY=giá trị, cách nhau bằng dấu cách.' },
    { id: 'roles', label: 'Cho phép', kind: 'cycle', value: draft.roles, options: Object.keys(ROLE_CHOICES), hint: 'Vai trò nào được dùng server này. Mặc định chỉ coder: AI Duo không biết tool nào chỉ đọc.' },
  ];
}

const BLANK: McpDraft = { name: '', command: '', args: '', env: '', roles: 'coder' };

type View = { kind: 'list' } | { kind: 'form'; draft: McpDraft; index: number } | { kind: 'confirm'; index: number };

const LIST_HINTS = [['↑↓', 'chọn'], ['e/Enter', 'sửa'], ['n', 'mới'], ['d', 'xoá'], ['Esc', 'đóng']] as const;
const FORM_HINTS = [['↑↓', 'chọn ô'], ['Enter', 'sửa'], ['←→', 'đổi'], ['s', 'lưu'], ['Esc', 'quay lại']] as const;

const describe = (server: McpServer) => `${[server.command, ...(server.args ?? [])].join(' ')} · ${choiceOf(server.roles)}`;

/** /mcp: MCP servers handed to Claude and Codex turns; each is limited to the roles that may use it. */
export default function McpPanel({ onClose }: Readonly<PanelProps>) {
  const loaded = useLoader(() => getCliSettings());
  const [view, setView] = useState<View>({ kind: 'list' });
  const [error, setError] = useState<string | undefined>();
  const cli: CliSettings | undefined = loaded.data;
  const servers = cli?.mcp ?? [];

  const save = async (next: McpServer[]) => {
    if (!cli) return;
    setError(undefined);
    try {
      const result = await setCliSettings({ ...cli, mcp: next });
      if (typeof result === 'string') {
        setError(result);
        return;
      }
      loaded.reload();
      setView({ kind: 'list' });
    } catch (err) {
      setError(errorText(err));
    }
  };

  let body;
  if (view.kind === 'form') {
    const { draft, index } = view;
    body = (
      <Form
        fields={mcpFields(draft)}
        onChange={(id, value) => setView({ ...view, draft: { ...draft, [id]: value } })}
        onSave={() => void save(index < 0 ? [...servers, serverOf(draft)] : servers.map((s, i) => (i === index ? serverOf(draft) : s)))}
        onCancel={() => {
          setError(undefined);
          setView({ kind: 'list' });
        }}
        maxRows={9}
      />
    );
  } else if (view.kind === 'confirm') {
    body = <Confirm message={`Xoá MCP server "${servers[view.index]?.name ?? ''}"?`} onYes={() => void save(servers.filter((_, i) => i !== view.index))} onNo={() => setView({ kind: 'list' })} />;
  } else {
    body = (
      <Box flexDirection="column">
        <SelectList
          items={servers.map((server, index) => ({ server, index }))}
          getKey={(item) => item.server.name}
          getLabel={(item) => item.server.name}
          getDescription={(item) => describe(item.server)}
          onSelect={(item) => setView({ kind: 'form', draft: draftOf(item.server), index: item.index })}
          onCancel={onClose}
          onKey={(input, _key, item) => {
            if (input === 'n') setView({ kind: 'form', draft: BLANK, index: -1 });
            else if (item && input === 'e') setView({ kind: 'form', draft: draftOf(item.server), index: item.index });
            else if (item && input === 'd') setView({ kind: 'confirm', index: item.index });
          }}
          emptyText={loaded.loading ? 'Đang tải…' : 'Chưa có MCP server nào. Nhấn n để thêm.'}
          maxHeight={8}
        />
        <Text dimColor>Server áp dụng cho Claude và Codex; Antigravity chưa hỗ trợ MCP qua dòng lệnh.</Text>
      </Box>
    );
  }
  return (
    <Panel title="MCP servers" subtitle={`${servers.length} server`} hints={view.kind === 'form' ? FORM_HINTS : LIST_HINTS} error={error ?? loaded.error} onClose={view.kind === 'list' ? onClose : undefined}>
      {body}
    </Panel>
  );
}
