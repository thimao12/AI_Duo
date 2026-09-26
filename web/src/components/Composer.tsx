import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, CircleAlert, Folder, FolderOpen, GitMerge, ImagePlus, ListTodo, MessagesSquare, SlidersHorizontal, Sparkles, Waypoints, X } from 'lucide-react';
import { api, type AgentName, type AgentStatus, type ModelCatalog, type NewRunRequest, type RoutePreview, type RunConfig } from '../api.ts';
import ModelPicker from './ModelPicker.tsx';
import { AgentDot, AGENT_LABEL, basename, MenuItem, MenuLabel, MODE_LABEL, Popover, Spinner } from './ui.tsx';

type Mode = NewRunRequest['mode'];
type Form = Omit<RunConfig, 'models' | 'efforts' | 'mode' | 'route' | 'images'> & { mode: Mode; models: Record<AgentName, string>; efforts: Record<AgentName, string> };
type DraftImage = { name: string; dataUrl: string };
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const STORAGE_KEY = 'ai-duo:new-run';

/** Bridge exposed by the Electron preload; undefined in a normal browser. */
const desktop = (window as { aiDuo?: { pickFolder: (defaultPath?: string) => Promise<string | null> } }).aiDuo;

const DEFAULTS: Form = {
  mode: 'auto',
  prompt: '',
  cwd: '',
  maxRounds: 2,
  judge: 'claude',
  coder: 'codex',
  testCommand: '',
  turnTimeoutMin: 30,
  models: { claude: '', codex: '' },
  efforts: { claude: '', codex: '' },
};

function loadForm(): Form {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULTS, ...saved, prompt: '', models: { ...DEFAULTS.models, ...saved.models }, efforts: { ...DEFAULTS.efforts, ...saved.efforts } };
  } catch {
    return DEFAULTS;
  }
}

export const MODES: { id: Mode; icon: typeof Sparkles; hint: string }[] = [
  { id: 'auto', icon: Sparkles, hint: 'Router chọn chế độ, AI nào code và model theo độ khó, ưu tiên ít token.' },
  { id: 'debate', icon: MessagesSquare, hint: 'Cả hai đề xuất, review chéo, rồi chốt một giải pháp. Chỉ đọc repo.' },
  { id: 'pair', icon: GitMerge, hint: 'Một con code trong repo, con kia review diff và chạy test tới khi approve.' },
  { id: 'plan', icon: ListTodo, hint: 'Một agent khảo sát repo ở chế độ chỉ đọc và lập kế hoạch triển khai, không sửa file.' },
];
export const MODE_ICON = Object.fromEntries(MODES.map((m) => [m.id, m.icon])) as Record<Mode, typeof Sparkles>;

/** The new-run form: persisted settings, router preview, CLI status and submit. */
function useNewRunForm(onCreated: (id: string) => void, threadCwd?: string, threadId?: string, onContinue?: () => void) {
  const [form, setForm] = useState<Form>(loadForm);
  const [agents, setAgents] = useState<AgentStatus | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [preview, setPreview] = useState<RoutePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState<DraftImage[]>([]);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const auto = form.mode === 'auto';

  // Inside a thread the composer targets that thread's project.
  useEffect(() => {
    if (threadCwd) setForm((f) => ({ ...f, cwd: threadCwd }));
  }, [threadCwd]);

  // Rules-only preview (free): what the router would pick for the prompt as typed.
  useEffect(() => {
    const prompt = form.prompt.trim();
    if (!auto || !prompt) return setPreview(null);
    const ctl = new AbortController();
    const t = setTimeout(() => api.previewRoute(prompt, ctl.signal).then(setPreview, () => {}), 400);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [auto, form.prompt]);

  useEffect(() => {
    api
      .agents()
      .then((a) => {
        setAgents(a);
        setForm((f) => (f.cwd ? f : { ...f, cwd: a.defaultCwd }));
      })
      .catch(() => setAgents(null));
    api.models().then(setCatalog, () => setCatalog(null));
  }, []);

  useEffect(() => {
    const { prompt: _omit, ...rest } = form;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
    } catch {}
  }, [form]);

  const submit = async () => {
    if (busy || (!form.prompt.trim() && !images.length)) return;
    setBusy(true);
    setError(null);
    try {
      // Auto: the router picks mode, agents and rounds; sending them would override it.
      const { maxRounds: _r, judge: _j, coder: _c, ...rest } = form;
      const { id } = threadId
        ? await api.continue(threadId, form.prompt, images)
        : await api.create({ ...(auto ? rest : form), images });
      setForm((f) => ({ ...f, prompt: '' }));
      setImages([]);
      if (threadId) onContinue?.();
      else onCreated(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addImages = async (files: File[]) => {
    setError(null);
    if (images.length + files.length > 4) return setError('Chỉ thêm tối đa 4 ảnh.');
    if (files.some((file) => !IMAGE_TYPES.has(file.type) || file.size > MAX_IMAGE_BYTES)) return setError('Chọn ảnh PNG, JPEG, WebP hoặc GIF, tối đa 5 MB mỗi ảnh.');
    try {
      const added = await Promise.all(files.map((file) => new Promise<DraftImage>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, dataUrl: String(reader.result) });
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      })));
      setImages((current) => current.length + added.length <= 4 ? [...current, ...added] : current);
    } catch {
      setError('Không đọc được ảnh.');
    }
  };

  return { form, set, setForm, agents, catalog, preview, error, busy, submit, auto, images, setImages, addImages };
}

export interface ComposerSeed {
  prompt: string;
  mode: Mode;
  /** Bump to re-apply the same seed. */
  n: number;
}

interface ComposerProps {
  variant: 'hero' | 'dock';
  projects: string[];
  onCreated: (id: string) => void;
  threadCwd?: string;
  threadId?: string;
  onContinue?: () => void;
  seed?: ComposerSeed;
  onAgents?: (a: AgentStatus | null) => void;
}

const field =
  'w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[13px] text-fg placeholder:text-faint transition-colors hover:border-line-strong focus:border-focus focus:outline-none placeholder:font-sans';

export default function Composer({ variant, projects, onCreated, threadCwd, threadId, onContinue, seed, onAgents }: ComposerProps) {
  const { form, set, setForm, agents, catalog, preview, error, busy, submit, auto, images, setImages, addImages } = useNewRunForm(onCreated, threadCwd, threadId, onContinue);
  const text = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [typingPath, setTypingPath] = useState(false);
  const hero = variant === 'hero';
  const side = hero ? 'bottom' : 'top';

  useEffect(() => onAgents?.(agents), [agents, onAgents]);

  useEffect(() => {
    if (!seed) return;
    setForm((f) => ({ ...f, prompt: seed.prompt, mode: seed.mode }));
    text.current?.focus();
  }, [seed, setForm]);

  // Grow with the text, up to a cap; beyond it the textarea scrolls.
  useLayoutEffect(() => {
    const el = text.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * (hero ? 0.42 : 0.32))}px`;
  }, [form.prompt, hero]);

  const reviewer: AgentName = form.coder === 'claude' ? 'codex' : 'claude';
  const ModeIcon = MODE_ICON[form.mode];
  const recent = [...new Set([form.cwd, ...projects].filter(Boolean))].slice(0, 8);
  const canSend = (!!form.prompt.trim() || images.length > 0) && !busy;

  const pick = async (close: () => void) => {
    const dir = await desktop?.pickFolder(form.cwd);
    if (dir) set('cwd', dir);
    close();
  };

  return (
    <div className={hero ? '' : 'pb-4'}>
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 px-1" aria-label="Ảnh đính kèm">
          {images.map((image, index) => (
            <div key={`${image.name}-${index}`} className="relative size-16 overflow-hidden rounded-lg border border-line bg-surface" title={image.name}>
              <img src={image.dataUrl} alt={image.name} className="size-full object-cover" />
              <button type="button" onClick={() => setImages((current) => current.filter((_, i) => i !== index))} aria-label={`Xóa ảnh ${image.name}`} className="absolute top-0 right-0 rounded-bl bg-bg/90 p-0.5 text-fg">
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="rounded-[20px] border border-line bg-bg shadow-card"
      >
        <label htmlFor="composer-input" className="sr-only">
          Task cho Claude và Codex
        </label>
        <textarea
          id="composer-input"
          ref={text}
          rows={hero ? 3 : 1}
          value={form.prompt}
          autoFocus={hero}
          onChange={(e) => set('prompt', e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files).filter((file) => file.type.startsWith('image/'));
            if (files.length) {
              e.preventDefault();
              void addImages(files);
            }
          }}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line; never while an IME (Telex/VNI) is composing.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={
            hero
              ? 'Mô tả vấn đề hoặc task. Ví dụ: sửa lỗi upload file rỗng, viết test cho nó'
              : threadId ? 'Nhắn tiếp trong phiên này…' : `Task mới trong ${basename(form.cwd || '…')}. Sẽ tạo phiên mới.`
          }
          className={`composer-input block w-full resize-none bg-transparent px-4 text-[14.5px] leading-relaxed text-fg placeholder:text-faint focus:outline-none ${hero ? 'min-h-24 pt-4 pb-2' : 'min-h-11 pt-3 pb-1'}`}
        />

        {!threadId && auto && preview && (
          <p className="flex items-start gap-1.5 px-4 pb-1 text-[12px] leading-snug text-faint">
            <Waypoints aria-hidden className="mt-px size-3.5 shrink-0" />
            <span className="line-clamp-2">
              {preview.askHaiku ? 'Chưa chắc loại task, Haiku sẽ phân loại khi gửi (~1k token). Tạm đoán: ' : 'Dự kiến: '}
              {preview.route.reason.split('\n')[0]}
            </span>
          </p>
        )}

        <div className="flex items-center gap-0.5 px-2 pt-1 pb-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
            <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="sr-only" aria-label="Chọn ảnh" onChange={(e) => { void addImages(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
            <button type="button" onClick={() => imageInput.current?.click()} aria-label="Thêm ảnh" title="Thêm ảnh" className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface hover:text-fg">
              <ImagePlus aria-hidden className="size-4" />
            </button>
            {!threadId && <>
            <Popover
              side={side}
              width="w-80"
              title={form.cwd}
              label={
                <>
                  <Folder aria-hidden className="size-3.5 shrink-0" />
                  <span className="truncate">{form.cwd ? basename(form.cwd) : 'Chọn project'}</span>
                </>
              }
            >
              {(close) => (
                <>
                  <MenuLabel>Project</MenuLabel>
                  {recent.map((p) => (
                    <MenuItem
                      key={p}
                      selected={p === form.cwd}
                      icon={<Folder className="size-3.5" />}
                      label={basename(p)}
                      hint={<span className="block truncate font-mono text-[11px]">{p}</span>}
                      onSelect={() => {
                        set('cwd', p);
                        close();
                      }}
                    />
                  ))}
                  <div className="my-1 border-t border-line" />
                  {desktop && <MenuItem icon={<FolderOpen className="size-3.5" />} label="Chọn thư mục…" onSelect={() => void pick(close)} />}
                  {typingPath ? (
                    <div className="px-1.5 py-1">
                      <input
                        autoFocus
                        defaultValue={form.cwd}
                        placeholder="C:\path\to\repo"
                        className={`${field} font-mono`}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            set('cwd', e.currentTarget.value.trim());
                            setTypingPath(false);
                            close();
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <MenuItem label="Nhập đường dẫn…" onSelect={() => setTypingPath(true)} />
                  )}
                  <p className="px-2.5 pt-1 pb-1.5 text-[11.5px] leading-snug text-faint">
                    Pair sửa file thật trong project (cần git repo, không tự commit). Debate chỉ đọc.
                  </p>
                </>
              )}
            </Popover>

            <Popover
              side={side}
              width="w-72"
              label={
                <>
                  <ModeIcon aria-hidden className="size-3.5 shrink-0" />
                  {MODE_LABEL[form.mode]}
                </>
              }
            >
              {(close) => (
                <>
                  <MenuLabel>Chế độ</MenuLabel>
                  {MODES.map((m) => (
                    <MenuItem
                      key={m.id}
                      selected={form.mode === m.id}
                      icon={<m.icon className="size-3.5" />}
                      label={MODE_LABEL[m.id]}
                      hint={m.hint}
                      onSelect={() => {
                        setForm((f) => ({ ...f, mode: m.id, maxRounds: m.id === 'pair' ? 3 : 2 }));
                        close();
                      }}
                    />
                  ))}
                </>
              )}
            </Popover>

            {!auto && (
              <Popover
                side={side}
                width="w-64"
                label={
                  <>
                    <AgentDot agent={form.mode === 'pair' ? form.coder : form.judge} />
                    {form.mode === 'pair' ? `${AGENT_LABEL[form.coder]} code` : form.mode === 'plan' ? `${AGENT_LABEL[form.coder]} lập kế hoạch` : `${AGENT_LABEL[form.judge]} chốt`}
                  </>
                }
              >
                {(close) => (
                  <>
                    <MenuLabel>{form.mode === 'pair' ? 'Ai viết code?' : form.mode === 'plan' ? 'Agent lập kế hoạch' : 'Ai viết giải pháp cuối?'}</MenuLabel>
                    {(['claude', 'codex'] as const).map((a) => (
                      <MenuItem
                        key={a}
                        selected={(form.mode === 'pair' || form.mode === 'plan' ? form.coder : form.judge) === a}
                        icon={<AgentDot agent={a} className="mt-1" />}
                        label={AGENT_LABEL[a]}
                        hint={form.mode === 'pair' ? `${AGENT_LABEL[a === 'claude' ? 'codex' : 'claude']} sẽ review và chạy test` : undefined}
                        onSelect={() => {
                          set(form.mode === 'pair' || form.mode === 'plan' ? 'coder' : 'judge', a);
                          close();
                        }}
                      />
                    ))}
                  </>
                )}
              </Popover>
            )}

            {!auto && form.mode !== 'plan' && (
              <Popover side={side} width="w-44" label={`${form.maxRounds} vòng`}>
                {(close) => (
                  <>
                    <MenuLabel>{form.mode === 'pair' ? 'Số vòng review' : 'Số vòng review chéo'}</MenuLabel>
                    {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                      <MenuItem
                        key={n}
                        selected={form.maxRounds === n}
                        label={`${n} vòng`}
                        onSelect={() => {
                          set('maxRounds', n);
                          close();
                        }}
                      />
                    ))}
                  </>
                )}
              </Popover>
            )}

            {(['codex', 'claude'] as const).map((a) => (
              <ModelPicker
                key={a}
                agent={a}
                catalog={catalog}
                model={form.models[a]}
                effort={form.efforts[a]}
                auto={auto}
                side={side}
                onChange={({ model, effort }) =>
                  setForm((f) => ({ ...f, models: { ...f.models, [a]: model }, efforts: { ...f.efforts, [a]: effort } }))
                }
              />
            ))}

            <Popover
              side={side}
              width="w-80"
              title="Tùy chọn nâng cao"
              showChevron={false}
              label={
                <>
                  <SlidersHorizontal aria-hidden className="size-3.5" />
                  <span className="sr-only">Tùy chọn nâng cao</span>
                </>
              }
            >
              {() => (
                <div className="space-y-3 p-2">
                  <p className="text-[12px] font-medium text-faint">Tùy chọn nâng cao</p>
                  {form.mode !== 'debate' && (
                    <label className="block space-y-1">
                      <span className="text-[12.5px] text-muted">Lệnh test</span>
                      <input className={`${field} font-mono`} value={form.testCommand} onChange={(e) => set('testCommand', e.target.value)} placeholder="Trống = reviewer tự tìm" />
                    </label>
                  )}
                  <label className="block space-y-1">
                    <span className="text-[12.5px] text-muted">Giới hạn mỗi lượt (phút)</span>
                    <input
                      type="number"
                      min={1}
                      max={180}
                      className={`${field} w-24`}
                      value={form.turnTimeoutMin}
                      onChange={(e) => set('turnTimeoutMin', Number(e.target.value))}
                    />
                  </label>
                </div>
              )}
            </Popover>
            </>}
          </div>

          <button
            type="submit"
            disabled={!canSend}
            aria-label={busy ? (auto && preview?.askHaiku ? 'Đang phân tích task' : 'Đang khởi động') : 'Gửi'}
            title="Gửi (Enter)"
            className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-fg transition-[opacity,transform] hover:opacity-85 active:scale-95 disabled:bg-surface-2 disabled:text-faint"
          >
            {busy ? <Spinner className="size-4 text-current" /> : <ArrowUp aria-hidden className="size-4" strokeWidth={2.4} />}
          </button>
        </div>
      </form>

      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 px-2 text-[12.5px] text-danger">
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      )}
      {hero && (
        <p className="mt-2.5 px-2 text-[12px] text-faint">
          {form.mode === 'pair'
            ? `${AGENT_LABEL[form.coder]} viết code, ${AGENT_LABEL[reviewer]} review và chạy test. Không tự commit.`
            : 'Enter để gửi, Shift + Enter để xuống dòng.'}
        </p>
      )}
    </div>
  );
}
