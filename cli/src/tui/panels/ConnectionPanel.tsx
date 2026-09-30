import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AgentName } from '../../../../server/src/agents/types.ts';
import { getConnection, openLogin, type LoginOutcome } from '../../../../server/src/connection.ts';
import type { ConnectionStatus } from '../../../../server/src/types.ts';
import type { PanelProps } from '../panel-types.ts';
import { errText, paint, useLoader } from '../util.ts';
import Panel from '../widgets/Panel.tsx';

const RECHECK_AFTER_LOGIN_MS = 5000;
const AGENTS: readonly AgentName[] = ['claude', 'codex'];
const LABEL: Record<AgentName, string> = { claude: 'Claude', codex: 'Codex' };

export const INSTALL_COMMAND: Record<AgentName, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
};

export const LOGIN_COMMAND: Record<AgentName, string> = {
  claude: 'claude auth login',
  codex: 'codex login',
};

const OUTCOME_TEXT: Record<LoginOutcome, string> = {
  opened: 'Đã mở cửa sổ terminal. Hoàn tất đăng nhập ở đó, rồi nhấn r để kiểm tra lại.',
  notInstalled: 'CLI chưa được cài: làm bước 1 trước.',
  failed: 'Không mở được terminal. Hãy chạy lệnh đăng nhập ở trên trong terminal của bạn.',
};

/** Human-readable connection state of a CLI. */
export function connectionLabel(status: ConnectionStatus): string {
  if (!status.installed) return 'Chưa cài';
  if (status.loggedIn === false) return 'Đã cài, chưa đăng nhập';
  if (status.loggedIn === null) return 'Không xác định';
  const detail = [status.method, status.account].filter(Boolean).join(' · ');
  return detail ? `Đã đăng nhập (${detail})` : 'Đã đăng nhập';
}

/** True when the user still has something to do (install or log in). */
export const needsSetup = (status: ConnectionStatus): boolean => !status.installed || status.loggedIn === false;

function statusColor(status: ConnectionStatus): string {
  if (needsSetup(status)) return 'red';
  return status.loggedIn === null ? 'yellow' : 'green';
}

function Guide({ name, status }: Readonly<{ name: AgentName; status: ConnectionStatus }>) {
  let step = 1;
  return (
    <Box flexDirection="column" marginLeft={4}>
      {status.installed ? null : <Text>{`${step++}. Cài CLI: `}<Text bold>{INSTALL_COMMAND[name]}</Text></Text>}
      <Text>{`${step++}. Đăng nhập: `}<Text bold>{LOGIN_COMMAND[name]}</Text><Text dimColor>{'   (hoặc nhấn o để mở terminal đăng nhập)'}</Text></Text>
      <Text>{`${step}. Nhấn r để kiểm tra lại.`}</Text>
      <Text dimColor>Đăng nhập bằng gói thuê bao; biến API key tính phí theo token bị bỏ khi chạy.</Text>
    </Box>
  );
}

function AgentBlock({ name, status, selected }: Readonly<{ name: AgentName; status: ConnectionStatus | undefined; selected: boolean }>) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={paint('cyan')}>{selected ? '❯ ' : '  '}</Text>
        <Text color={status ? paint(statusColor(status)) : undefined}>● </Text>
        <Text bold>{LABEL[name]}</Text>
        <Text>{`  ${status ? connectionLabel(status) : 'Đang kiểm tra…'}`}</Text>
        {status?.version ? <Text dimColor>{`  ${status.version}`}</Text> : null}
      </Box>
      {status?.error && status.installed ? <Text color={paint('red')}>{`    ${status.error}`}</Text> : null}
      {status && needsSetup(status) ? <Guide name={name} status={status} /> : null}
    </Box>
  );
}

export interface ConnectionPanelProps extends PanelProps {
  /** Replaces the real status lookup (tests). */
  loader?: (agent: AgentName) => Promise<ConnectionStatus>;
  /** Replaces the real login launcher (tests). */
  opener?: (agent: AgentName) => Promise<LoginOutcome>;
}

/** /login: install and login state of both CLIs, the exact commands to fix them, `o` opens the login terminal, `r` rechecks. */
export default function ConnectionPanel({ onClose, loader = (agent) => getConnection(agent), opener = (agent) => openLogin(agent) }: Readonly<ConnectionPanelProps>) {
  const { data, error, reload } = useLoader(() => Promise.all(AGENTS.map((agent) => loader(agent))));
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState<string | undefined>();
  const [recheckAt, setRecheckAt] = useState(0);

  useEffect(() => {
    if (!recheckAt) return undefined;
    const timer = setTimeout(() => reload(), RECHECK_AFTER_LOGIN_MS);
    return () => clearTimeout(timer);
  }, [recheckAt, reload]);

  const open = () => {
    setMessage(undefined);
    opener(AGENTS[selected]).then(
      (outcome) => {
        setMessage(OUTCOME_TEXT[outcome]);
        if (outcome === 'opened') setRecheckAt(Date.now());
      },
      (err: unknown) => setMessage(errText(err)),
    );
  };

  useInput((input, key) => {
    if (input === 'r') reload();
    else if (input === 'o') open();
    else if (key.tab || key.downArrow || key.rightArrow || input === 'j') setSelected((selected + 1) % AGENTS.length);
    else if (key.upArrow || key.leftArrow || input === 'k') setSelected((selected + AGENTS.length - 1) % AGENTS.length);
  });

  return (
    <Panel title="Kết nối & đăng nhập" onClose={onClose} error={error} hints={[['Tab', 'đổi agent'], ['o', 'mở terminal đăng nhập'], ['r', 'kiểm tra lại'], ['Esc', 'đóng']]}>
      {AGENTS.map((name, i) => (
        <AgentBlock key={name} name={name} status={data?.[i]} selected={i === selected} />
      ))}
      {message ? <Text color={paint('cyan')}>{message}</Text> : null}
    </Panel>
  );
}
