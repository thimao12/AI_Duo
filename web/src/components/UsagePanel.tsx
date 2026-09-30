import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, type AgentName, type AgentStatus, type AgentTestResult, type AgentUsage, type UsageReport, type UsageResetCredit, type UsageWindow } from '../api.ts';
import ConnectionGuide from './ConnectionGuide.tsx';
import { AGENT_LABEL, Spinner } from './ui.tsx';

const REFRESH_MS = 60_000;
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

/** A window whose reset time already passed and that was not just measured live has no trustworthy number. */
export function isExpiredWindow(win: UsageWindow, live: boolean, now = Date.now()): boolean {
  if (live) return false;
  if (win.stale === true) return true;
  return win.resetsAt !== undefined && new Date(win.resetsAt).getTime() <= now;
}

function ExpiredBar({ label }: Readonly<{ label: string }>) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[12px]">
      <span className="text-muted">{label}</span>
      <span className="text-[11px] text-faint">Đã reset – chưa có số liệu mới</span>
    </div>
  );
}

function UsageBar({ label, window: win, live }: Readonly<{ label: string; window: UsageWindow; live: boolean }>) {
  if (isExpiredWindow(win, live)) return <ExpiredBar label={label} />;
  const percent = Math.min(100, Math.max(0, Math.round(win.usedPercent)));
  return (
    <div>
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="text-muted">{label}</span>
        <span className="font-medium text-fg">{percent}%</span>
      </div>
      <div aria-hidden className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className={`h-full rounded-full ${barColor(percent)}`} style={{ width: `${percent}%` }} />
      </div>
      <meter className="sr-only" min={0} max={100} value={percent} aria-label={`${label}: đã dùng ${percent}%`}>{percent}%</meter>
      {win.resetsAt && (
        <div className="mt-1 flex justify-between text-[11px] text-faint">
          <span>{formatReset(win.resetsAt)}</span>
          <span>{formatRemaining(win.resetsAt)}</span>
        </div>
      )}
    </div>
  );
}

const isLive = (usage: AgentUsage) => usage.live === true || usage.source === 'live';

/** "trực tiếp", "từ log lúc 14:05" or "từ lần chạy lúc 14:05". */
export function sourceLabel(usage: AgentUsage): string {
  if (isLive(usage)) return 'trực tiếp';
  const base = usage.source === 'codex-session-log' ? 'từ log' : 'từ lần chạy';
  return usage.updatedAt ? `${base} lúc ${clock(new Date(usage.updatedAt))}` : base;
}

function SourceBadge({ usage }: Readonly<{ usage: AgentUsage }>) {
  return (
    <span className={`shrink-0 rounded-full border px-1.5 py-px text-[11px] ${isLive(usage) ? 'border-ok/40 text-ok' : 'border-line text-faint'}`}>
      {sourceLabel(usage)}
    </span>
  );
}

function UsageNotice({ name, error }: Readonly<{ name: AgentName; error: NonNullable<AgentUsage['error']> }>) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (error === 'unavailable') return <p className="mb-2 text-[11.5px] text-warn">Không lấy được số liệu trực tiếp</p>;
  const login = () => {
    setBusy(true);
    setMessage(null);
    api.openLogin(name).then(
      () => setMessage('Đã mở terminal đăng nhập.'),
      (err: Error) => setMessage(err.message),
    ).finally(() => setBusy(false));
  };
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-[11.5px]">
      <span className="text-warn">Cần đăng nhập lại</span>
      <button type="button" onClick={login} disabled={busy} className="inline-flex h-6 items-center gap-1 rounded-md border border-line px-2 text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-60">
        {busy && <Spinner className="size-3" />}
        Mở terminal đăng nhập
      </button>
      <output className="text-faint">{message}</output>
    </div>
  );
}

/** "Hết hạn 01:18 T6 23/10". */
export function formatExpiry(iso: string): string {
  const at = new Date(iso);
  const weekday = at.toLocaleDateString('vi-VN', { weekday: 'short' });
  return `Hết hạn ${clock(at)} ${weekday} ${pad(at.getDate())}/${pad(at.getMonth() + 1)}`;
}

function ResetCredit({ credit }: Readonly<{ credit: UsageResetCredit }>) {
  return (
    <li className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="min-w-0 truncate text-muted" title={credit.description}>{credit.title ?? 'Reset'}</span>
      {credit.expiresAt && <span className="shrink-0 text-faint">{formatExpiry(credit.expiresAt)}</span>}
    </li>
  );
}

function ResetCredits({ credits }: Readonly<{ credits: NonNullable<AgentUsage['resetCredits']> }>) {
  const available = credits.credits.filter((credit) => credit.status === 'available');
  return (
    <div className="mt-2.5 border-t border-line pt-2">
      <p className="text-[11.5px] font-medium text-muted">Bank reset: {credits.availableCount} lượt</p>
      {available.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {available.map((credit) => <ResetCredit key={credit.id} credit={credit} />)}
        </ul>
      )}
    </div>
  );
}

function UsageBars({ name, usage }: Readonly<{ name: AgentName; usage: AgentUsage | undefined }>) {
  if (!usage) return <p className="text-[11.5px] text-faint">Đang tải…</p>;
  const live = isLive(usage);
  const hasWindows = usage.fiveHour !== undefined || usage.weekly !== undefined;
  return (
    <div>
      {usage.error && <UsageNotice name={name} error={usage.error} />}
      {hasWindows ? (
        <div className="space-y-2.5">
          {usage.fiveHour && <UsageBar label="5 giờ" window={usage.fiveHour} live={live} />}
          {usage.weekly && <UsageBar label="Tuần" window={usage.weekly} live={live} />}
        </div>
      ) : (
        <p className="text-[11.5px] leading-snug text-faint">Chưa có dữ liệu quota.</p>
      )}
      {usage.resetCredits && <ResetCredits credits={usage.resetCredits} />}
    </div>
  );
}

/* ---- Agent card ------------------------------------------------------------ */

export function TestResult({ result }: Readonly<{ result: AgentTestResult }>) {
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
  recheckSignal: number;
  onOpenCliSettings?: () => void;
  usage: AgentUsage | undefined;
  version: string | null;
  error: string | null;
}

function AgentCard({ name, usage, version, error, recheckSignal, onOpenCliSettings }: Readonly<AgentCardProps>) {
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
        {usage?.plan && <span className="rounded bg-surface-2 px-1.5 py-px text-[11px] font-semibold uppercase text-muted">{usage.plan}</span>}
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-faint" title={error ?? undefined}>{shownVersion ?? error ?? 'chưa kết nối'}</span>
        <button type="button" onClick={runTest} disabled={testing} className="inline-flex h-6 items-center gap-1 rounded-md border border-line px-2 text-[11.5px] text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-60">
          {testing && <Spinner className="size-3" />}
          Test
        </button>
      </div>
      {usage && <div className="mt-1.5"><SourceBadge usage={usage} /></div>}
      <div className="mt-2.5">
        <UsageBars name={name} usage={usage} />
      </div>
      {result && <TestResult result={result} />}
      {testError && <p role="alert" className="mt-2 text-[11.5px] text-danger">{testError}</p>}
      <ConnectionGuide name={name} onOpenCliSettings={onOpenCliSettings} recheckSignal={recheckSignal} />
    </section>
  );
}

/* ---- Panel ----------------------------------------------------------------- */

export function useAgentStatus() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const refresh = useCallback(() => api.agents().then(setStatus, () => setStatus(null)), []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 60_000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { status, refresh };
}

interface UsageContentProps {
  status: AgentStatus | null;
  refreshStatus: () => Promise<void>;
  onOpenCliSettings?: () => void;
}

function UsageContent({ status, refreshStatus, onOpenCliSettings }: Readonly<UsageContentProps>) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback((force = false) => {
    setLoading(true);
    setError(null);
    return Promise.all([api.usage(force), refreshStatus()])
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
    <div className="p-4">
      <div className="flex items-center justify-between px-1 pb-2">
        <h2 className="text-[11px] font-semibold tracking-wide text-faint">USAGE &amp; KẾT NỐI</h2>
        <button type="button" onClick={() => void load(true)} disabled={loading} className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-60">
          <RefreshCw aria-hidden className={`size-3 ${loading ? 'animate-spin' : ''}`} />
          Làm mới
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {AGENTS.map((name) => (
          <AgentCard key={name} name={name} recheckSignal={updatedAt?.getTime() ?? 0} onOpenCliSettings={onOpenCliSettings} usage={report?.[name]} version={status?.[name] ?? null} error={status ? status[`${name}Error`] : null} />
        ))}
      </div>
      {error && <p role="alert" className="mt-2 px-1 text-[11.5px] text-danger">{error}</p>}
      <p className="mt-2 px-1 text-[11px] text-faint">
        {updatedAt ? `Cập nhật lúc ${clock(updatedAt)} · ` : ''}tự làm mới mỗi 60 giây
      </p>
    </div>
  );
}

/** Usage bars and connection status of every agent (Settings tab "Usage & kết nối"). */
export default function UsagePanel({ onOpenCliSettings }: Readonly<{ onOpenCliSettings?: () => void }>) {
  const { status, refresh } = useAgentStatus();
  return <UsageContent status={status} refreshStatus={refresh} onOpenCliSettings={onOpenCliSettings} />;
}
