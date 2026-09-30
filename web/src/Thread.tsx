import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction, type ReactNode, type RefObject } from 'react';
import { ArrowDown, Check, CircleAlert, Copy, FileDiff, FolderTree, ListChevronsDownUp, ListChevronsUpDown, PanelLeft, Square, WifiOff } from 'lucide-react';
import { api, useRun, type Message, type PairDecision, type PlanDecision, type Run } from './api.ts';
import ChangesPanel from './components/ChangesPanel.tsx';
import ExplorerPanel from './components/ExplorerPanel.tsx';
import PanelTabs, { type PanelTab } from './components/PanelTabs.tsx';
import ChoiceQuestion from './components/ChoiceQuestion.tsx';
import Composer, { MODE_ICON } from './components/Composer.tsx';
import { parseDiff } from './components/DiffView.tsx';
import Turn, { SystemNote } from './components/Turn.tsx';
import { basename, formatUsage, formatUsageShort, Markdown, MODE_LABEL, PHASE_LABEL, Spinner, StatusText, titleOf, useInputFocus } from './components/ui.tsx';

const iconBtn = 'grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-fg';

function phaseTitle(m: Message, run: Run): string {
  const label = PHASE_LABEL[m.phase] ?? m.phase;
  if (m.round <= 0 || m.phase === 'synthesize' || m.phase === 'propose') return label;
  // A fix turn answers the review of the previous round (the server numbers it round + 1).
  const round = m.phase === 'fix' ? m.round - 1 : m.round;
  return `${label} · vòng ${round}/${run.config.maxRounds + (run.pairRoundsGranted ?? 0)}`;
}

/** "Review & test · vòng 2/3", from the latest agent turn. */
function progressOf(run: Run): string | null {
  const last = [...run.messages].reverse().find((m) => m.agent === 'claude' || m.agent === 'codex');
  return last ? phaseTitle(last, run) : null;
}

function RunStatus({ run }: Readonly<{ run: Run }>) {
  if (run.planDecision) return <span className="text-info">Chờ bạn duyệt kế hoạch</span>;
  if (run.pairDecision) return <span className="text-info">Chờ bạn chọn bước tiếp</span>;
  return <StatusText status={run.status} />;
}

/** The user typed plain lines: make single newlines hard breaks, except inside code fences. */
function keepLineBreaks(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/)
    .map((chunk, i) => (i % 2 ? chunk : chunk.replace(/([^\n])\n(?!\n)/g, '$1  \n')))
    .join('');
}

function PromptBubble({ run, message }: Readonly<{ run: Run; message?: Message }>) {
  const { cwd } = run.config;
  const prompt = message?.parts[0]?.content ?? run.config.prompt;
  const images = message?.images ?? run.config.images;
  const createdAt = message?.startedAt ?? run.createdAt;
  const long = prompt.length > 700 || prompt.split('\n').length > 12;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[88%] rounded-2xl bg-surface px-4 py-2.5 text-[14px] leading-relaxed">
        {!!images?.length && <div className="mb-2 flex flex-wrap gap-2">{images.map((image, index) => {
          const url = message ? `/api/runs/${run.id}/messages/${message.id}/images/${index}` : `/api/runs/${run.id}/images/${index}`;
          return <a key={url} href={url} target="_blank" rel="noreferrer"><img src={url} alt={image.name} className="max-h-40 max-w-40 rounded-lg object-contain" /></a>;
        })}</div>}
        <div className={`prompt-md ${long && !expanded ? 'max-h-64 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]' : ''}`}>
          {prompt && <Markdown>{keepLineBreaks(prompt)}</Markdown>}
        </div>
        {long && (
          <button type="button" onClick={() => setExpanded((e) => !e)} className="mt-1 text-[12.5px] font-medium text-muted hover:text-fg">
            {expanded ? 'Thu gọn' : 'Xem toàn bộ'}
          </button>
        )}
      </div>
      <p className="mt-1.5 pr-1 text-[11.5px] text-faint" title={cwd}>
        {basename(cwd)} · {new Date(createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'numeric' })}
      </p>
    </div>
  );
}

const FINAL_HEADING: Partial<Record<string, string>> = { debate: 'Giải pháp cuối', plan: 'Kế hoạch' };

function FinalBlock({ run, files, onShowChanges }: Readonly<{ run: Run; files: number; onShowChanges: () => void }>) {
  const [copied, setCopied] = useState(false);
  const heading = FINAL_HEADING[run.config.mode] ?? 'Kết quả';
  return (
    <section aria-label="Kết quả" className="mt-10">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[13.5px] font-semibold">{heading}</h2>
        {files > 0 && (
          <button type="button" onClick={onShowChanges} className="text-[12.5px] text-muted underline-offset-2 hover:text-fg hover:underline">
            Xem thay đổi ({files} file)
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(run.final ?? '').then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted transition-colors hover:bg-surface hover:text-fg"
        >
          {copied ? <Check aria-hidden className="size-3.5 text-ok" /> : <Copy aria-hidden className="size-3.5" />}
          {copied ? 'Đã copy' : 'Copy'}
        </button>
      </div>
      <div className="rounded-2xl border border-line bg-surface/60 px-5 py-4">
        <Markdown>{run.final!}</Markdown>
      </div>
    </section>
  );
}

function PairFailureDecision({ runId, decision }: Readonly<{ runId: string; decision: PairDecision }>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function choose(continueRun: boolean) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.pairDecision(runId, continueRun);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  return (
    <section aria-label="Review chưa approve" aria-live="polite" className="mt-6 rounded-2xl border border-warn/30 bg-warn/5 p-4">
      <h2 className="text-[13.5px] font-semibold">Chưa được approve sau {decision.round} vòng review</h2>
      <p className="mt-1 text-[13px] text-muted">Bạn muốn cấp thêm 2 vòng sửa và review hay dừng tại đây?</p>
      {error && <p role="alert" className="mt-3 flex items-center gap-1.5 text-[12.5px] text-danger"><CircleAlert aria-hidden className="size-3.5" />{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void choose(true)} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-fg hover:opacity-85 disabled:opacity-50">
          {busy ? <Spinner className="size-3.5" /> : <Check aria-hidden className="size-3.5" />}
          Tiếp tục thêm 2 vòng
        </button>
        <button type="button" onClick={() => void choose(false)} disabled={busy} className="h-8 rounded-lg border border-line px-3 text-[12.5px] text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-50">
          Dừng
        </button>
      </div>
    </section>
  );
}

function PlanApprovalDecision({ runId, decision }: Readonly<{ runId: string; decision: PlanDecision }>) {
  const feedbackInput = useInputFocus<HTMLTextAreaElement>();
  const [refining, setRefining] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function choose(action: 'approve' | 'stop' | 'refine') {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.planDecision(runId, action, action === 'refine' ? feedback.trim() : undefined);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  return (
    <section aria-label="Duyệt kế hoạch" aria-live="polite" className="mt-6 rounded-2xl border border-focus/30 bg-focus/5 p-4">
      <h2 className="text-[13.5px] font-semibold">Bạn có đồng ý triển khai kế hoạch này không?</h2>
      <p className="mt-1 text-[13px] text-muted">Kế hoạch đã qua {decision.reviewRounds} lượt review. Chọn Có để bắt đầu code, Không để dừng, hoặc Khác để yêu cầu chỉnh sửa.</p>
      {error && <p role="alert" className="mt-3 flex items-center gap-1.5 text-[12.5px] text-danger"><CircleAlert aria-hidden className="size-3.5" />{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void choose('approve')} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-fg hover:opacity-85 disabled:opacity-50">
          {busy && !refining ? <Spinner className="size-3.5" /> : <Check aria-hidden className="size-3.5" />}
          Có, triển khai
        </button>
        <button type="button" onClick={() => void choose('stop')} disabled={busy} className="h-8 rounded-lg border border-line px-3 text-[12.5px] text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-50">
          Không, dừng
        </button>
        <button type="button" onClick={() => setRefining(true)} disabled={busy} className="h-8 rounded-lg border border-line px-3 text-[12.5px] text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-50">
          Khác, chỉnh kế hoạch
        </button>
      </div>
      {refining && (
        <div className="mt-3 space-y-2">
          <textarea ref={feedbackInput} value={feedback} onChange={(event) => setFeedback(event.target.value)} disabled={busy} rows={3} maxLength={8000} placeholder="Bạn muốn thay đổi gì trong kế hoạch?" className="block w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-[13px] text-fg placeholder:text-faint focus:border-focus focus:outline-none" />
          <button type="button" onClick={() => void choose('refine')} disabled={!feedback.trim() || busy} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-fg hover:opacity-85 disabled:opacity-50">
            {busy ? <Spinner className="size-3.5" /> : <ArrowDown aria-hidden className="size-3.5 rotate-[-90deg]" />}
            Gửi góp ý và review lại
          </button>
        </div>
      )}
    </section>
  );
}

function MessageRow({ run, message: m, prev, compact }: Readonly<{ run: Run; message: Message; prev?: Message; compact: boolean }>) {
  if (m.agent === 'user') return <div className="mt-8"><PromptBubble run={run} message={m} /></div>;
  const divider = m.agent !== 'system' && m.phase !== 'info' && (prev?.phase !== m.phase || prev.round !== m.round);
  let body: ReactNode;
  if (m.agent !== 'system') body = <Turn message={m} compact={compact} />;
  else if (m.phase === 'result') {
    body = (
      <section className="rounded-2xl border border-line bg-surface/60 px-5 py-4">
        <h2 className="mb-2 text-[13.5px] font-semibold">Kết quả lượt trước</h2>
        <Markdown>{m.parts.map((part) => part.content).join('\n')}</Markdown>
      </section>
    );
  } else body = <SystemNote message={m} />;
  return (
    <>
      {divider && (
        <div role="separator" className="flex items-center gap-3 pt-3 text-[11.5px] font-medium text-faint">
          <span className="h-px flex-1 bg-line" />
          {phaseTitle(m, run)}
          <span className="h-px flex-1 bg-line" />
        </div>
      )}
      {body}
    </>
  );
}

interface ThreadProps {
  id: string;
  title?: string;
  projects: string[];
  onCreated: (id: string) => void;
  onMenu: () => void;
  sidebarHidden: boolean;
}

function useFollowBottom({
  id,
  run,
  scroller,
  positioned,
  atBottom,
  setPanelOpen,
  setCompact,
}: Readonly<{
  id: string;
  run: Run | null | undefined;
  scroller: RefObject<HTMLDivElement | null>;
  positioned: MutableRefObject<boolean>;
  atBottom: boolean;
  setPanelOpen: (open: boolean) => void;
  setCompact: (compact: boolean) => void;
}>) {
  const lastLen = run?.messages.at(-1)?.parts.reduce((n, p) => n + p.content.length, 0);

  // Follow the bottom while the user is there; a live run opens at the bottom, a finished one at the top.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !run) return;
    if (!positioned.current) {
      positioned.current = true;
      if (run.status === 'running') el.scrollTop = el.scrollHeight;
      return;
    }
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [run, run?.messages.length, lastLen, run?.final, atBottom]);

  useEffect(() => {
    positioned.current = false;
    setPanelOpen(false);
    setCompact(false);
  }, [id]);
}

function RunStatusInfo({ run, progress, panelOpen }: Readonly<{ run: Run; progress: string | null; panelOpen: boolean }>) {
  const ModeIcon = MODE_ICON[run.config.mode as keyof typeof MODE_ICON] ?? null;
  return (
    <div className="mr-1 hidden items-center gap-3 lg:flex">
      <RunStatus run={run} />
      {progress && <span className="text-[12px] text-muted">{progress}</span>}
      {ModeIcon && (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-faint" title={run.config.route?.reason}>
          <ModeIcon aria-hidden className="size-3.5" />
          {MODE_LABEL[run.config.mode]}
          {run.config.route && ' · tự động'}
        </span>
      )}
      {run.usage && !panelOpen && (
        <span className="hidden font-mono text-[11.5px] text-faint xl:inline" title={`Tổng cả phiên: ${formatUsage(run.usage)}`}>
          Tổng {formatUsageShort(run.usage)}
        </span>
      )}
    </div>
  );
}

function DiffToggle({ files, panelOpen, setPanelOpen }: Readonly<{ files: ReturnType<typeof parseDiff>; panelOpen: boolean; setPanelOpen: Dispatch<SetStateAction<boolean>> }>) {
  const added = files.reduce((s, f) => s + f.added, 0);
  const removed = files.reduce((s, f) => s + f.removed, 0);
  const label = panelOpen ? 'Ẩn bảng thay đổi' : 'Hiện bảng thay đổi';
  return (
    <button
      type="button"
      onClick={() => setPanelOpen((open) => !open)}
      aria-pressed={panelOpen}
      aria-label={label}
      title={label}
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] transition-colors hover:bg-surface ${panelOpen ? 'bg-surface text-fg' : 'text-muted'}`}
    >
      <FileDiff aria-hidden className="size-4" />
      <span className="font-mono text-add-fg">+{added}</span>
      <span className="font-mono text-del-fg">−{removed}</span>
    </button>
  );
}

function ExplorerToggle({ open, onToggle }: Readonly<{ open: boolean; onToggle: () => void }>) {
  const label = open ? 'Ẩn Explorer' : 'Hiện Explorer';
  return (
    <button type="button" onClick={onToggle} aria-pressed={open} aria-label={label} title={label} className={`${iconBtn} ${open ? 'bg-surface text-fg' : ''}`}>
      <FolderTree aria-hidden className="size-4" />
    </button>
  );
}

function RunControls({ run, progress, files, panelOpen, explorerOpen, compact, setCompact, setPanelOpen, onToggleExplorer }: Readonly<{
  run: Run;
  progress: string | null;
  files: ReturnType<typeof parseDiff>;
  panelOpen: boolean;
  explorerOpen: boolean;
  compact: boolean;
  setCompact: Dispatch<SetStateAction<boolean>>;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
  onToggleExplorer: () => void;
}>) {
  const compactLabel = compact ? 'Mở rộng tất cả lượt' : 'Thu gọn tất cả lượt';
  return (
    <div className="flex shrink-0 items-center gap-1">
      <RunStatusInfo run={run} progress={progress} panelOpen={panelOpen} />
      {/* Narrow windows: the running step matters more than the word "running". */}
      <span className="min-w-0 truncate lg:hidden">
        {progress ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-info">
            <Spinner className="size-3 text-info" />
            <span className="truncate">{progress}</span>
          </span>
        ) : (
          <RunStatus run={run} />
        )}
      </span>
      <button type="button" onClick={() => setCompact((c) => !c)} title={compactLabel} aria-pressed={compact} className={iconBtn}>
        {compact ? <ListChevronsUpDown aria-hidden className="size-4" /> : <ListChevronsDownUp aria-hidden className="size-4" />}
        <span className="sr-only">{compactLabel}</span>
      </button>
      <ExplorerToggle open={explorerOpen} onToggle={onToggleExplorer} />
      {files.length > 0 && <DiffToggle files={files} panelOpen={panelOpen} setPanelOpen={setPanelOpen} />}
      {run.status === 'running' && (
        <button
          type="button"
          onClick={() => void api.cancel(run.id)}
          className="ml-1 inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12.5px] font-medium text-fg transition-colors hover:border-danger/50 hover:bg-danger/8 hover:text-danger"
        >
          <Square aria-hidden className="size-3 fill-current" />
          Dừng
        </button>
      )}
    </div>
  );
}

function RunBody({ run, files, compact, setPanelOpen, onContinue }: Readonly<{
  run: Run;
  files: number;
  compact: boolean;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
  onContinue: () => void;
}>) {
  return (
    <div className="mx-auto max-w-[760px] px-5 pt-8 pb-12">
      <PromptBubble run={run} />
      <div className="mt-8 space-y-5">
        {run.messages.map((m, i) => (
          <MessageRow key={m.id} run={run} message={m} prev={run.messages[i - 1]} compact={compact} />
        ))}
      </div>
  
      {run.pairDecision && <PairFailureDecision runId={run.id} decision={run.pairDecision} />}
  
      {run.error && (
        <p role="alert" className="mt-8 flex gap-2 rounded-xl bg-danger/8 px-4 py-3 text-[13px] text-danger">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 font-mono whitespace-pre-wrap">{run.error}</span>
        </p>
      )}
      {run.status === 'cancelled' && <p className="mt-8 text-center text-[12.5px] text-faint">Phiên đã dừng.</p>}
      {run.final && <FinalBlock run={run} files={files} onShowChanges={() => setPanelOpen(true)} />}
      {run.planDecision && <PlanApprovalDecision runId={run.id} decision={run.planDecision} />}
      {run.status === 'done' && run.final && run.config.mode !== 'plan' && (
        <ChoiceQuestion
          key={run.messages.at(-1)?.id}
          runId={run.id}
          text={run.final}
          onContinue={onContinue}
        />
      )}
    </div>
  );
}

export default function Thread({ id, title, projects, onCreated, onMenu, sidebarHidden }: Readonly<ThreadProps>) {
  const [revision, setRevision] = useState(0);
  const { run, reconnecting, error } = useRun(id, revision);
  const [compact, setCompact] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const positioned = useRef(false);

  const files = useMemo(() => parseDiff(run?.diff ?? ''), [run?.diff]);
  const running = run?.status === 'running';

  // The two right-hand panels share one column; opening the diff closes the explorer.
  useEffect(() => { if (panelOpen) setExplorerOpen(false); }, [panelOpen]);
  const changesVisible = panelOpen && run?.diff !== undefined;
  const panelVisible = changesVisible || explorerOpen;
  const toggleExplorer = () => { setPanelOpen(false); setExplorerOpen((open) => !open); };
  const selectTab = (tab: PanelTab) => {
    if (tab === 'explorer') { setPanelOpen(false); setExplorerOpen(true); }
    else { setExplorerOpen(false); setPanelOpen(true); }
  };

  useFollowBottom({ id, run, scroller, positioned, atBottom, setPanelOpen, setCompact });

  const onScroll = () => {
    const el = scroller.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const onContinue = () => {
    positioned.current = false;
    setAtBottom(true);
    setRevision((n) => n + 1);
  };

  if (error)
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <p className="flex items-center gap-2 text-[13.5px] text-danger">
          <CircleAlert aria-hidden className="size-4" />
          {error}
        </p>
      </div>
    );

  const progress = run && running ? progressOf(run) : null;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className={`app-drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-3 sm:px-4 ${panelVisible ? '' : 'titlebar-inset'}`}>
          <button type="button" onClick={onMenu} title="Hiện danh sách phiên (Ctrl B)" className={`${iconBtn} ${sidebarHidden ? '' : 'md:hidden'}`}>
            <PanelLeft aria-hidden className="size-4" />
            <span className="sr-only">Hiện danh sách phiên</span>
          </button>
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <h1 className="min-w-0 truncate text-[13.5px] font-semibold">{run ? title || run.title || titleOf(run.config.prompt) : 'Đang tải…'}</h1>
            {run && <span className="hidden shrink-0 text-[12.5px] text-faint sm:inline">{basename(run.config.cwd)}</span>}
          </div>
          {run && <RunControls run={run} progress={progress} files={files} panelOpen={panelOpen} explorerOpen={explorerOpen} compact={compact} setCompact={setCompact} setPanelOpen={setPanelOpen} onToggleExplorer={toggleExplorer} />}
        </header>

        {reconnecting && (
          <output className="flex items-center justify-center gap-2 border-b border-line bg-warn/10 px-4 py-1.5 text-[12.5px] text-warn">
            <WifiOff aria-hidden className="size-3.5" />
            Mất kết nối, đang kết nối lại…
          </output>
        )}

        <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
          {!run ? (
            <div className="mx-auto max-w-[760px] space-y-4 px-5 pt-10" aria-hidden>
              <div className="ml-auto h-14 w-2/3 animate-pulse rounded-2xl bg-surface" />
              <div className="h-4 w-1/3 animate-pulse rounded bg-surface" />
              <div className="h-24 animate-pulse rounded-xl bg-surface" />
            </div>
          ) : (
            <RunBody run={run} files={files.length} compact={compact} setPanelOpen={setPanelOpen} onContinue={onContinue} />
          )}
        </div>

        <div className="relative shrink-0 px-3 sm:px-5">
          {!atBottom && run && (
            <button
              type="button"
              onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })}
              className="absolute -top-11 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-bg px-3 text-[12.5px] text-muted shadow-card transition-colors hover:text-fg"
            >
              <ArrowDown aria-hidden className="size-3.5" />
              {running ? 'Mới nhất' : 'Xuống cuối'}
            </button>
          )}
          <div className="mx-auto max-w-[760px]">
            <Composer variant="dock" projects={projects} onCreated={onCreated} threadCwd={run?.config.cwd} threadId={id} threadMode={run?.config.mode} onContinue={onContinue} />
          </div>
        </div>
      </div>

      {panelVisible && run && (
        <div className="fixed inset-0 z-40 lg:static lg:z-auto lg:w-[min(40vw,560px)] lg:shrink-0 lg:border-l lg:border-line">
          {explorerOpen ? (
            <ExplorerPanel cwd={run.config.cwd} onClose={() => setExplorerOpen(false)} tabs={<PanelTabs active="explorer" changesAvailable={run.diff !== undefined} onSelect={selectTab} />} />
          ) : (
            <ChangesPanel files={files} diff={run.diff ?? ''} onClose={() => setPanelOpen(false)} tabs={<PanelTabs active="changes" changesAvailable onSelect={selectTab} />} />
          )}
        </div>
      )}
    </div>
  );
}
