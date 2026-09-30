import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AgentName } from '../../../../server/src/agents/types.ts';
import { detectCli } from '../../../../server/src/routes/cli-settings.ts';
import type { AgentUsage, UsageReport, UsageResetCredit, UsageWindow } from '../../../../server/src/types.ts';
import { getUsage } from '../../../../server/src/usage.ts';
import { barColor, clampPercent, clock, formatExpiry, formatRemaining, formatReset, isExpiredWindow, isLive, leftColor, remainingPercent, sourceLabel, textBar } from '../format.ts';
import type { PanelProps } from '../panel-types.ts';
import { getService } from '../service.ts';
import { paint, useInterval, useLoader } from '../util.ts';
import Panel from '../widgets/Panel.tsx';

const REFRESH_MS = 60_000;
const AGENTS: readonly AgentName[] = ['claude', 'codex'];
const LABEL: Record<AgentName, string> = { claude: 'Claude', codex: 'Codex' };

export interface UsageData {
  report: UsageReport;
  /** CLI version per agent; null/missing when it is not installed. */
  versions: Partial<Record<AgentName, string | null>>;
}

export type UsageLoader = (force: boolean) => Promise<UsageData>;

/** Live usage of both agents plus their CLI versions. */
export const loadUsage: UsageLoader = async (force) => {
  const runs = await getService().list();
  const [report, claude, codex] = await Promise.all([getUsage(runs, Date.now(), { force }), detectCli('claude'), detectCli('codex')]);
  return { report, versions: { claude: claude.version, codex: codex.version } };
};

interface BarRowProps {
  label: string;
  window: UsageWindow;
  live: boolean;
  /** Codex reports what is left; Claude what is used. */
  left: boolean;
}

function BarRow({ label, window: win, live, left }: Readonly<BarRowProps>) {
  if (isExpiredWindow(win, live)) {
    return (
      <Text>
        {'  '}
        <Text dimColor>{label.padEnd(7)}Đã reset – chưa có số liệu mới</Text>
      </Text>
    );
  }
  const percent = left ? remainingPercent(win.usedPercent) : clampPercent(win.usedPercent);
  const color = left ? leftColor(percent) : barColor(percent);
  const suffix = left ? 'còn lại' : 'đã dùng';
  return (
    <Box>
      <Text>{`  ${label.padEnd(7)}`}</Text>
      <Text color={paint(color)}>{textBar(percent)}</Text>
      <Text bold>{` ${String(percent).padStart(3)}% `}</Text>
      <Text>{`${suffix} `}</Text>
      {win.resetsAt ? (
        <Box flexShrink={1}>
          <Text dimColor wrap="truncate-end">{`${formatReset(win.resetsAt)} · ${formatRemaining(win.resetsAt)}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function CreditLine({ credit }: Readonly<{ credit: UsageResetCredit }>) {
  const expiry = credit.expiresAt ? `  ${formatExpiry(credit.expiresAt)}` : '';
  return (
    <Text wrap="truncate-end" dimColor>
      {`    · ${credit.title ?? 'Reset'}${expiry}`}
    </Text>
  );
}

function ResetCredits({ credits }: Readonly<{ credits: NonNullable<AgentUsage['resetCredits']> }>) {
  const available = credits.credits.filter((credit) => credit.status === 'available');
  return (
    <Box flexDirection="column">
      <Text>{`  Bank reset: ${credits.availableCount} lượt`}</Text>
      {available.map((credit) => <CreditLine key={credit.id} credit={credit} />)}
    </Box>
  );
}

function Notice({ error }: Readonly<{ error: NonNullable<AgentUsage['error']> }>) {
  if (error === 'unavailable') return <Text color={paint('yellow')}>{'  Không lấy được số liệu trực tiếp'}</Text>;
  return <Text color={paint('yellow')}>{'  Cần đăng nhập lại: chạy /login'}</Text>;
}

interface CardProps {
  name: AgentName;
  usage: AgentUsage | undefined;
  version: string | null | undefined;
}

function AgentCard({ name, usage, version }: Readonly<CardProps>) {
  const live = usage ? isLive(usage) : false;
  const hasWindows = usage?.fiveHour !== undefined || usage?.weekly !== undefined;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={paint(version ? 'green' : 'red')}>● </Text>
        <Text bold>{LABEL[name]}</Text>
        {usage?.plan ? <Text color={paint('cyan')}>{` ${usage.plan.toUpperCase()}`}</Text> : null}
        <Text dimColor>{`  ${version ?? 'chưa kết nối'}`}</Text>
        {usage ? <Text color={paint(live ? 'green' : 'gray')}>{`  [${sourceLabel(usage)}]`}</Text> : null}
      </Box>
      {usage?.error ? <Notice error={usage.error} /> : null}
      {usage?.fiveHour ? <BarRow label="5 giờ" window={usage.fiveHour} live={live} left={name === 'codex'} /> : null}
      {usage?.weekly ? <BarRow label="Tuần" window={usage.weekly} live={live} left={name === 'codex'} /> : null}
      {usage && !hasWindows ? <Text dimColor>{'  Chưa có dữ liệu quota.'}</Text> : null}
      {usage?.resetCredits ? <ResetCredits credits={usage.resetCredits} /> : null}
      {usage ? null : <Text dimColor>{'  Đang tải…'}</Text>}
    </Box>
  );
}

export interface UsagePanelProps extends PanelProps {
  /** Replaces the live lookup (tests). */
  loader?: UsageLoader;
}

/** /usage: plan usage windows and CLI versions of Claude and Codex; `r` refreshes, and it refreshes itself every minute. */
export default function UsagePanel({ onClose, loader = loadUsage }: Readonly<UsagePanelProps>) {
  const { data, error, loading, reload } = useLoader(loader);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  useInterval(() => reload(false), REFRESH_MS);
  useEffect(() => {
    if (data) setUpdatedAt(new Date());
  }, [data]);
  useInput((input) => {
    if (input === 'r') reload(true);
  });

  const refreshing = loading ? 'Đang làm mới… ' : '';
  const updated = updatedAt ? `Cập nhật lúc ${clock(updatedAt)} · ` : '';
  return (
    <Panel title="Usage" onClose={onClose} error={error} hints={[['r', 'làm mới'], ['Esc', 'đóng']]}>
      {AGENTS.map((name) => (
        <AgentCard key={name} name={name} usage={data?.report[name]} version={data?.versions[name]} />
      ))}
      <Text dimColor>{`${refreshing}${updated}tự làm mới mỗi 60 giây`}</Text>
    </Panel>
  );
}
