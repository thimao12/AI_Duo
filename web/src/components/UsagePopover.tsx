import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, type AgentName, type AgentStatus, type AgentTestResult, type AgentUsage, type UsageReport, type UsageWindow } from '../api.ts';
import { AGENT_LABEL, Popover, Spinner } from './ui.tsx';

const REFRESH_MS = 5 * 60_000;
const AGENTS: AgentName[] = ['claude', 'codex'];

/* ---- Formatting ------------------------------------------------------------ */

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Reset 14:59 hôm nay", "Reset 09:00 ngày mai" or "Reset Th 5 03/10 09:00" for far resets. */
export function formatReset(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const dayDiff = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (dayDiff === 0) return `Reset ${clock(at)} hôm nay`;
  if (dayDiff === 1) return `Reset ${clock(at)} ngày mai`;
  const weekday = at.toLocaleDateString('vi-VN', { weekday: 'short' });
  return `Reset ${weekday} ${pad(at.getDate())}/${pad(at.getMonth() + 1)} ${clock(at)}`;
}

/** "còn 1g 20p", "còn 45p", "còn 2n 3g". */
export function formatRemaining(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
  if (minutes < 60) return `còn ${minutes}p`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `còn ${hours}g ${minutes % 60}p`;
  return `còn ${Math.floor(hours / 24)}n ${hours % 24}g`;
}

function barColor(percent: number): string {
  if (percent >= 90) return 'bg-danger';
  if (percent >= 75) return 'bg-warn';
  return 'bg-ok';
}

/* ---- Usage bars ------------------------------------------------------------ */

function UsageBar({ label, window: win }: Readonly<{ label: string; window: UsageWindow }>) {
  const percent = Math.min(100, Math.max(0, Math.round(win.usedPercent)));
  const stale = win.stale === true;
  return (
    <div className={stale ? 'opacity-60' : ''}>
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="text-muted">
          {label}
          {stale && <span className="ml-1.5 text-[11px] text-faint">đã cũ</span>}
        </span>
        <span className="font-medium text-fg">{percent}%</span>
      </div>
      <div aria-hidden className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className={`h-full rounded-full ${stale ? 'bg-faint' : barColor(percent)}`} style={{ width: `${percent}%` }} />
      </div>
      <meter className="sr-only" min={0} max={100} value={percent} aria-label={`${label}: đã dùng ${percent}%`}>{percent}%</meter>
      {win.resetsAt && (
        <div className="mt-1 flex justify-between text-[11px] text-faint">
          <span>{formatReset(win.resetsAt)}</span>
          {!stale && <span>{formatRemaining(win.resetsAt)}</span>}
        </div>
      )}
    </div>
  );
}

function UsageBars({ usage }: Readonly<{ usage: AgentUsage | undefined }>) {
  if (!usage) return <p className="text-[11.5px] text-faint">Đang tải…</p>;
  if (!usage.fiveHour && !usage.weekly) return <p className="text-[11.5px] leading-snug text-faint">Chưa có dữ liệu quota.</p>;
  return (
    <div className="space-y-2.5">
      {usage.fiveHour && <UsageBar label="5 giờ" window={usage.fiveHour} />}
      {usage.weekly && <UsageBar label="Tuần" window={usage.weekly} />}
    </div>
  );
}

/* ---- Agent card ------------------------------------------------------------ */

function TestResult({ result }: Readonly<{ result: AgentTestResult }>) {
  if (result.ok && result.problems.length === 0) {
    return <p className="mt-2 text-[11.5px] text-ok">Kết nối ổn{result.authUnverified ? ' (chưa xác minh đăng nhập)' : ''}.</p>;
  }
  return (
    <ul className="mt-2 space-y-0.5 text-[11.5px] text-danger">
      {result.problems.map((problem) => <li key={problem}>{problem}</li>)}
    </ul>
  );
}

interface AgentCardProps {
  name: AgentName;
  usage: AgentUsage | undefined;
  version: string | null;
  error: string | null;
}

function AgentCard({ name, usage, version, error }: Readonly<AgentCardProps>) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AgentTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const shownVersion = result?.version.version ?? version;
  const connected = result ? result.ok : version !== null;

  const runTest = () => {
    setTesting(true);
    setTestError(null);
    api.testAgent(name).then(setResult, (err: Error) => setTestError(err.message)).finally(() => setTesting(false));
  };

  return (
    <section aria-label={AGENT_LABEL[name]} className="rounded-lg border border-line bg-surface/40 p-2.5">
      <div className="flex items-center gap-2">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${connected ? 'bg-ok' : 'bg-danger'}`} />
        <span className="text-[13px] font-medium text-fg">{AGENT_LABEL[name]}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-faint" title={error ?? undefined}>{shownVersion ?? error ?? 'chưa kết nối'}</span>
        <button type="button" onClick={runTest} disabled={testing} className="inline-flex h-6 items-center gap-1 rounded-md border border-line px-2 text-[11.5px] text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-60">
          {testing && <Spinner className="size-3" />}
          Test
        </button>
      </div>
      <div className="mt-2.5">
        <UsageBars usage={usage} />
      </div>
      {result && <TestResult result={result} />}
      {testError && <p role="alert" className="mt-2 text-[11.5px] text-danger">{testError}</p>}
    </section>
  );
}

/* ---- Panel ----------------------------------------------------------------- */

function useAgentStatus() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const refresh = useCallback(() => api.agents().then(setStatus, () => setStatus(null)), []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 60_000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { status, refresh };
}

function UsagePanel({ status, refreshStatus }: Readonly<{ status: AgentStatus | null; refreshStatus: () => Promise<void> }>) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    return Promise.all([api.usage(), refreshStatus()])
      .then(([value]) => { setReport(value); setUpdatedAt(new Date()); })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [refreshStatus]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="p-1.5">
      <div className="flex items-center justify-between px-1 pb-2">
        <h2 className="text-[11px] font-semibold tracking-wide text-faint">USAGE &amp; KẾT NỐI</h2>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-60">
          <RefreshCw aria-hidden className={`size-3 ${loading ? 'animate-spin' : ''}`} />
          Làm mới
        </button>
      </div>
      <div className="space-y-2">
        {AGENTS.map((name) => (
          <AgentCard key={name} name={name} usage={report?.[name]} version={status?.[name] ?? null} error={status ? status[`${name}Error`] : null} />
        ))}
      </div>
      {error && <p role="alert" className="mt-2 px-1 text-[11.5px] text-danger">{error}</p>}
      <p className="mt-2 px-1 text-[11px] text-faint">
        {updatedAt ? `Cập nhật lúc ${clock(updatedAt)} · ` : ''}tự làm mới mỗi 5 phút
      </p>
    </div>
  );
}

function connectionText(status: AgentStatus | null): string {
  if (!status) return 'đang kiểm tra';
  return status.claude && status.codex ? 'kết nối' : 'chưa đủ CLI';
}

function StatusLabel({ status }: Readonly<{ status: AgentStatus | null }>) {
  const dot = (name: AgentName) => (status?.[name] ? 'bg-ok' : 'bg-faint');
  return (
    <>
      <span className="flex items-center gap-1.5"><span aria-hidden className={`size-2 rounded-full ${dot('claude')}`} />Claude</span>
      <span className="flex items-center gap-1.5"><span aria-hidden className={`size-2 rounded-full ${dot('codex')}`} />Codex</span>
      <span className="ml-auto text-[11.5px] text-faint">{connectionText(status)}</span>
    </>
  );
}

/** Sidebar status line ("Claude ● Codex ● kết nối") that opens the usage & connection popover. */
export default function UsagePopover() {
  const { status, refresh } = useAgentStatus();
  return (
    <Popover
      label={<StatusLabel status={status} />}
      title="Usage & kết nối"
      side="top"
      align="start"
      width="w-[288px]"
      showChevron={false}
      triggerClassName="flex h-8 w-full items-center gap-3 rounded-lg px-2.5 text-left text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg aria-expanded:bg-surface-2"
    >
      {() => <UsagePanel status={status} refreshStatus={refresh} />}
    </Popover>
  );
}
