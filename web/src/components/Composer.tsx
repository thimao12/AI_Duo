import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, CircleAlert, Folder, FolderOpen, GitMerge, ImagePlus, ListTodo, SlidersHorizontal, Sparkles, Waypoints, X } from 'lucide-react';
import { api, type AgentName, type AgentStatus, type ModelCatalog, type NewRunRequest, type RoutePreview, type RunConfig } from '../api.ts';
import ModelPicker from './ModelPicker.tsx';
import { AGENT_LABEL, basename, MenuItem, MenuLabel, MODE_LABEL, Popover, Spinner } from './ui.tsx';
import { loadDraftImages, saveDraftImages, type DraftImage } from '../draft-images.ts';

type Mode = NewRunRequest['mode'];
type Form = Omit<RunConfig, 'models' | 'efforts' | 'mode' | 'route' | 'images'> & { mode: Mode; models: Record<AgentName, string>; efforts: Record<AgentName, string> };
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const STORAGE_KEY = 'ai-duo:new-run';

/** Bridge exposed by the Electron preload; undefined in a normal browser. */
const desktop = (window as { aiDuo?: { pickFolder: (defaultPath?: string) => Promise<string | null> } }).aiDuo;

const DEFAULTS: Form = {
  mode: 'code',
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
    // Every new composer starts in Code; Plan is only entered with Shift+Tab.
    return { ...DEFAULTS, ...saved, mode: 'code', prompt: typeof saved.prompt === 'string' ? saved.prompt : '', models: { ...DEFAULTS.models, ...saved.models }, efforts: { ...DEFAULTS.efforts, ...saved.efforts } };
  } catch {
    return DEFAULTS;
  }
}

export const MODES: { id: Mode; icon: typeof Sparkles; hint: string }[] = [
  { id: 'code', icon: GitMerge, hint: 'Router tự chọn agent code và review. Hỏi bạn sau 2 vòng nếu vẫn chưa approve.' },
  { id: 'plan', icon: ListTodo, hint: 'Hai vai trò lập và review kế hoạch; chỉ bắt đầu code sau khi bạn duyệt.' },
];
export const MODE_ICON = Object.fromEntries(MODES.map((m) => [m.id, m.icon])) as Record<Mode, typeof Sparkles>;

/** The new-run form: persisted settings, router preview, CLI status and submit. */
function useNewRunForm(onCreated: (id: string) => void, threadCwd?: string, threadId?: string, threadMode?: RunConfig['mode'], onContinue?: () => void) {
  const [form, setForm] = useState<Form>(loadForm);
  const [agents, setAgents] = useState<AgentStatus | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [preview, setPreview] = useState<RoutePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState<DraftImage[]>([]);
  const [imagesReady, setImagesReady] = useState(false);
  const imageRef = useRef<DraftImage[]>([]);
  const imagesTouched = useRef(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const auto = true;

  useEffect(() => {
    let mounted = true;
    void loadDraftImages().then((saved) => {
      if (mounted && !imagesTouched.current) {
        imageRef.current = saved;
        setImages(saved);
      }
    }).catch(() => {
      if (mounted) setError('Không thể khôi phục ảnh nháp.');
    }).finally(() => {
      if (mounted) setImagesReady(true);
    });
    return () => { mounted = false; };
  }, []);

  // Inside a thread the composer targets that thread's project.
  useEffect(() => {
    if (threadCwd) setForm((f) => ({ ...f, cwd: threadCwd }));
  }, [threadCwd]);

  useEffect(() => {
    if (!threadId || !threadMode) return;
    const mode: Mode = threadMode === 'plan' ? 'plan' : 'code';
    setForm((f) => f.mode === mode ? f : { ...f, mode });
  }, [threadId, threadMode]);

  // Rules-only preview (free): what the router would pick for the prompt as typed.
  useEffect(() => {
    const prompt = form.prompt.trim();
    if (!prompt) return setPreview(null);
    const ctl = new AbortController();
    const t = setTimeout(() => api.previewRoute(prompt, form.mode, ctl.signal).then(setPreview, () => {}), 400);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [form.mode, form.prompt]);

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
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    } catch {}
  }, [form]);

  const submit = async () => {
    if (busy || !imagesReady || (!form.prompt.trim() && !images.length)) return;
    setBusy(true);
    setError(null);
    try {
      // The router always selects the agents and the two-round review policy.
      const { maxRounds: _r, judge: _j, coder: _c, reviewer: _reviewer, ...rest } = form;
      const { id } = threadId
        ? await api.continue(threadId, form.prompt, images, form)
        : await api.create({ ...rest, images });
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...form, prompt: '' }));
      } catch {}
      setForm((f) => ({ ...f, prompt: '' }));
      imageRef.current = [];
      setImages([]);
      await saveDraftImages([]).catch(() => {});
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
    if (imageRef.current.length + files.length > 4) return setError('Chỉ thêm tối đa 4 ảnh.');
    if (files.some((file) => !IMAGE_TYPES.has(file.type) || file.size > MAX_IMAGE_BYTES)) return setError('Chọn ảnh PNG, JPEG, WebP hoặc GIF, tối đa 5 MB mỗi ảnh.');
    try {
      const added = await Promise.all(files.map((file) => new Promise<DraftImage>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, dataUrl: String(reader.result) });
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      })));
      const next = [...imageRef.current, ...added];
      if (next.length > 4) return setError('Chá»‰ thÃªm tá»‘i Ä‘a 4 áº£nh.');
      imagesTouched.current = true;
      imageRef.current = next;
      setImages(next);
      await saveDraftImages(next);
    } catch {
      setError('Không đọc được ảnh.');
    }
  };

  const removeImage = async (index: number) => {
    const next = imageRef.current.filter((_, i) => i !== index);
    imagesTouched.current = true;
    imageRef.current = next;
    setImages(next);
    await saveDraftImages(next).catch(() => setError('Không thể lưu ảnh nháp.'));
  };

  return { form, set, setForm, agents, catalog, preview, error, busy, submit, auto, images, imagesReady, removeImage, addImages };
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
  threadMode?: RunConfig['mode'];
  onContinue?: () => void;
  seed?: ComposerSeed;
  onAgents?: (a: AgentStatus | null) => void;
}

const field =
  'w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[13px] text-fg placeholder:text-faint transition-colors hover:border-line-strong focus:border-focus focus:outline-none placeholder:font-sans';

export default function Composer({ variant, projects, onCreated, threadCwd, threadId, threadMode, onContinue, seed, onAgents }: ComposerProps) {
  const { form, set, setForm, agents, catalog, preview, error, busy, submit, auto, images, imagesReady, removeImage, addImages } = useNewRunForm(onCreated, threadCwd, threadId, threadMode, onContinue);
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

  const PlanIcon = MODE_ICON.plan;
  const recent = [...new Set([form.cwd, ...projects].filter(Boolean))].slice(0, 8);
  const canSend = imagesReady && (!!form.prompt.trim() || images.length > 0) && !busy;

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
              <button type="button" onClick={() => void removeImage(index)} aria-label={`Xóa ảnh ${image.name}`} className="absolute top-0 right-0 rounded-bl bg-bg/90 p-0.5 text-fg">
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
            // Shift+Tab toggles Code ↔ Plan; plain Tab still moves focus.
            if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              setForm((f) => ({ ...f, mode: f.mode === 'plan' ? 'code' : 'plan', maxRounds: 2 }));
            }
          }}
          placeholder={
            hero
              ? 'Mô tả vấn đề hoặc task. Ví dụ: sửa lỗi upload file rỗng, viết test cho nó'
              : threadId ? 'Nhắn tiếp trong phiên này…' : `Task mới trong ${basename(form.cwd || '…')}. Sẽ tạo phiên mới.`
          }
          className={`composer-input block w-full resize-none bg-transparent px-4 text-[14.5px] leading-relaxed text-fg placeholder:text-faint focus:outline-none ${hero ? 'min-h-24 pt-4 pb-2' : 'min-h-11 pt-3 pb-1'}`}
        />

        {auto && preview && (
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
            <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple disabled={!imagesReady} className="sr-only" aria-label="Chọn ảnh" onChange={(e) => { void addImages(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
            <button type="button" onClick={() => imageInput.current?.click()} aria-label="Thêm ảnh" title="Thêm ảnh" disabled={!imagesReady} className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface hover:text-fg disabled:opacity-50">
              <ImagePlus aria-hidden className="size-4" />
            </button>
            <>
            {threadId ? (
              <span title={threadCwd || form.cwd} className="inline-flex h-8 max-w-40 items-center gap-1.5 px-2 text-[12.5px] text-muted">
                <Folder aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">{basename(threadCwd || form.cwd || 'Project')}</span>
              </span>
            ) : (
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
                    Code có thể sửa file trong repo Git (không tự commit). Plan chỉ đọc cho tới khi bạn duyệt kế hoạch.
                  </p>
                </>
              )}
            </Popover>
            )}

            {form.mode === 'plan' && (
              <span role="status" title="Shift + Tab để quay lại Code" className="inline-flex h-8 items-center gap-1.5 px-2 text-[12.5px] font-medium text-fg">
                <PlanIcon aria-hidden className="size-3.5 shrink-0" />
                {MODE_LABEL.plan}
              </span>
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
                  <label className="block space-y-1">
                    <span className="text-[12.5px] text-muted">Lệnh test</span>
                    <input className={`${field} font-mono`} value={form.testCommand} onChange={(e) => set('testCommand', e.target.value)} placeholder="Trống = reviewer tự tìm" />
                  </label>
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
            </>
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
            {form.mode === 'code'
              ? preview ? `${AGENT_LABEL[preview.coder]} code, ${AGENT_LABEL[preview.reviewer]} review và chạy test. Hỏi bạn sau 2 vòng chưa approve.` : 'Router tự chọn agent code và review theo task.'
              : preview ? `${AGENT_LABEL[preview.coder]} lập kế hoạch, ${AGENT_LABEL[preview.reviewer]} review. Chỉ sửa repo sau khi bạn duyệt.` : 'Hai agent sẽ lập và review kế hoạch trước khi hỏi bạn.'}
            {' '}Enter để gửi, Shift + Enter để xuống dòng, Shift + Tab để chuyển Code/Plan.
        </p>
      )}
    </div>
  );
}
