import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Check, CircleAlert, Copy, FileDiff, ListChevronsDownUp, ListChevronsUpDown, Menu, Square, WifiOff } from 'lucide-react';
import { api, useRun, type Message, type Run } from './api.ts';
import ChangesPanel from './components/ChangesPanel.tsx';
import Composer, { MODE_ICON } from './components/Composer.tsx';
import { parseDiff } from './components/DiffView.tsx';
import Turn, { SystemNote } from './components/Turn.tsx';
import { basename, formatUsage, formatUsageShort, Markdown, MODE_LABEL, PHASE_LABEL, Spinner, StatusText, titleOf } from './components/ui.tsx';

const iconBtn = 'grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-fg';

function phaseTitle(m: Message, run: Run): string {
  const label = PHASE_LABEL[m.phase] ?? m.phase;
  if (m.round <= 0 || m.phase === 'synthesize' || m.phase === 'propose') return label;
  // A fix turn answers the review of the previous round (the server numbers it round + 1).
  const round = m.phase === 'fix' ? m.round - 1 : m.round;
  return `${label} · vòng ${round}/${run.config.maxRounds}`;
}

/** "Review & test · vòng 2/3", from the latest agent turn. */
function progressOf(run: Run): string | null {
  const last = [...run.messages].reverse().find((m) => m.agent !== 'system');
  return last ? phaseTitle(last, run) : null;
}

/** The user typed plain lines: make single newlines hard breaks, except inside code fences. */
function keepLineBreaks(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/)
    .map((chunk, i) => (i % 2 ? chunk : chunk.replace(/([^\n])\n(?!\n)/g, '$1  \n')))
    .join('');
}

function PromptBubble({ prompt, cwd, createdAt }: { prompt: string; cwd: string; createdAt: number }) {
  const long = prompt.length > 700 || prompt.split('\n').length > 12;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[88%] rounded-2xl bg-surface px-4 py-2.5 text-[14px] leading-relaxed">
        <div className={`prompt-md ${long && !expanded ? 'max-h-64 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]' : ''}`}>
          <Markdown>{keepLineBreaks(prompt)}</Markdown>
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

function FinalBlock({ run, files, onShowChanges }: { run: Run; files: number; onShowChanges: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <section aria-label="Kết quả" className="mt-10">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[13.5px] font-semibold">{run.config.mode === 'debate' ? 'Giải pháp cuối' : 'Kết quả'}</h2>
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

interface ThreadProps {
  id: string;
  projects: string[];
  onCreated: (id: string) => void;
  onMenu: () => void;
}

export default function Thread({ id, projects, onCreated, onMenu }: ThreadProps) {
  const { run, reconnecting, error } = useRun(id);
  const [compact, setCompact] = useState(false);
  const [panel, setPanel] = useState<boolean | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const positioned = useRef(false);

  const files = useMemo(() => parseDiff(run?.diff ?? ''), [run?.diff]);
  const added = files.reduce((s, f) => s + f.added, 0);
  const removed = files.reduce((s, f) => s + f.removed, 0);
  // The changes panel opens by itself once there is a diff on a wide window, until the user decides.
  const panelOpen = panel ?? (files.length > 0 && typeof window !== 'undefined' && window.innerWidth >= 1180);
  const running = run?.status === 'running';

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
    setPanel(null);
    setCompact(false);
  }, [id]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
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

  const ModeIcon = run ? MODE_ICON[run.config.mode] : null;
  const progress = run && running ? progressOf(run) : null;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className={`app-drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-3 sm:px-4 ${panelOpen && run?.diff !== undefined ? '' : 'titlebar-inset'}`}>
          <button type="button" onClick={onMenu} className={`${iconBtn} md:hidden`}>
            <Menu aria-hidden className="size-4" />
            <span className="sr-only">Mở danh sách phiên</span>
          </button>
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <h1 className="min-w-0 truncate text-[13.5px] font-semibold">{run ? titleOf(run.config.prompt) : 'Đang tải…'}</h1>
            {run && <span className="hidden shrink-0 text-[12.5px] text-faint sm:inline">{basename(run.config.cwd)}</span>}
          </div>
          {run && (
            <div className="flex shrink-0 items-center gap-1">
              <div className="mr-1 hidden items-center gap-3 lg:flex">
                <StatusText status={run.status} />
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
              {/* Narrow windows: the running step matters more than the word "running". */}
              <span className="min-w-0 truncate lg:hidden">
                {progress ? (
                  <span className="inline-flex items-center gap-1.5 text-[12px] text-info">
                    <Spinner className="size-3 text-info" />
                    <span className="truncate">{progress}</span>
                  </span>
                ) : (
                  <StatusText status={run.status} />
                )}
              </span>
              <button
                type="button"
                onClick={() => setCompact((c) => !c)}
                title={compact ? 'Mở rộng tất cả lượt' : 'Thu gọn tất cả lượt'}
                aria-pressed={compact}
                className={iconBtn}
              >
                {compact ? <ListChevronsUpDown aria-hidden className="size-4" /> : <ListChevronsDownUp aria-hidden className="size-4" />}
                <span className="sr-only">{compact ? 'Mở rộng tất cả lượt' : 'Thu gọn tất cả lượt'}</span>
              </button>
              {files.length > 0 && (
                <button
                  type="button"
                  onClick={() => setPanel(!panelOpen)}
                  aria-pressed={panelOpen}
                  title="Thay đổi"
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] transition-colors hover:bg-surface ${panelOpen ? 'bg-surface text-fg' : 'text-muted'}`}
                >
                  <FileDiff aria-hidden className="size-4" />
                  <span className="font-mono text-add-fg">+{added}</span>
                  <span className="font-mono text-del-fg">−{removed}</span>
                </button>
              )}
              {running && (
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
          )}
        </header>

        {reconnecting && (
          <p role="status" className="flex items-center justify-center gap-2 border-b border-line bg-warn/10 px-4 py-1.5 text-[12.5px] text-warn">
            <WifiOff aria-hidden className="size-3.5" />
            Mất kết nối, đang kết nối lại…
          </p>
        )}

        <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
          {!run ? (
            <div className="mx-auto max-w-[760px] space-y-4 px-5 pt-10" aria-hidden>
              <div className="ml-auto h-14 w-2/3 animate-pulse rounded-2xl bg-surface" />
              <div className="h-4 w-1/3 animate-pulse rounded bg-surface" />
              <div className="h-24 animate-pulse rounded-xl bg-surface" />
            </div>
          ) : (
            <div className="mx-auto max-w-[760px] px-5 pt-8 pb-12">
              <PromptBubble prompt={run.config.prompt} cwd={run.config.cwd} createdAt={run.createdAt} />
              <div className="mt-8 space-y-5">
                {run.messages.map((m, i) => {
                  const prev = run.messages[i - 1];
                  const divider = m.agent !== 'system' && m.phase !== 'info' && (!prev || prev.phase !== m.phase || prev.round !== m.round);
                  return (
                    <Fragment key={m.id}>
                      {divider && (
                        <div role="separator" className="flex items-center gap-3 pt-3 text-[11.5px] font-medium text-faint">
                          <span className="h-px flex-1 bg-line" />
                          {phaseTitle(m, run)}
                          <span className="h-px flex-1 bg-line" />
                        </div>
                      )}
                      {m.agent === 'system' ? <SystemNote message={m} /> : <Turn message={m} compact={compact} />}
                    </Fragment>
                  );
                })}
              </div>

              {run.error && (
                <p role="alert" className="mt-8 flex gap-2 rounded-xl bg-danger/8 px-4 py-3 text-[13px] text-danger">
                  <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0 font-mono whitespace-pre-wrap">{run.error}</span>
                </p>
              )}
              {run.status === 'cancelled' && <p className="mt-8 text-center text-[12.5px] text-faint">Phiên đã dừng.</p>}
              {run.final && <FinalBlock run={run} files={files.length} onShowChanges={() => setPanel(true)} />}
            </div>
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
            <Composer variant="dock" projects={projects} onCreated={onCreated} threadCwd={run?.config.cwd} />
          </div>
        </div>
      </div>

      {panelOpen && run?.diff !== undefined && (
        <>
          <div className="fixed inset-0 z-40 lg:static lg:z-auto lg:w-[min(40vw,560px)] lg:shrink-0 lg:border-l lg:border-line">
            <ChangesPanel files={files} diff={run.diff ?? ''} onClose={() => setPanel(false)} />
          </div>
        </>
      )}
    </div>
  );
}
