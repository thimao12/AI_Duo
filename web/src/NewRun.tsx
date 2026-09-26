import { useEffect, useState, type ReactNode } from "react";
import {
  api,
  type AgentName,
  type AgentStatus,
  type NewRunRequest,
  type RoutePreview,
  type RunConfig,
} from "./api.ts";

type Form = Omit<RunConfig, "models" | "mode" | "route"> & {
  mode: NewRunRequest["mode"];
  models: Record<AgentName, string>;
};

const STORAGE_KEY = "ai-duo:new-run";

/** Bridge exposed by the Electron preload; undefined when running in a normal browser. */
const desktop = (
  window as {
    aiDuo?: { pickFolder: (defaultPath?: string) => Promise<string | null> };
  }
).aiDuo;
const DEFAULTS: Form = {
  mode: "auto",
  prompt: "",
  cwd: "",
  maxRounds: 2,
  judge: "claude",
  coder: "codex",
  testCommand: "",
  turnTimeoutMin: 30,
  models: { claude: "", codex: "" },
};

function loadForm(): Form {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      ...DEFAULTS,
      ...saved,
      prompt: "",
      models: { ...DEFAULTS.models, ...saved.models },
    };
  } catch {
    return DEFAULTS;
  }
}

const MODES = [
  {
    id: "auto",
    title: "Tự động",
    desc: "Tự chọn chế độ, AI và model theo độ khó của task, ưu tiên tiết kiệm token",
  },
  {
    id: "debate",
    title: "Debate",
    desc: "Cả 2 cùng đề xuất → review chéo → chốt 1 giải pháp tốt nhất",
  },
  {
    id: "pair",
    title: "Pair",
    desc: "1 con code trong repo, con kia review diff + chạy test, lặp tới khi approve",
  },
] as const;

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium text-zinc-400">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-600">{hint}</span>}
    </label>
  );
}

const box =
  "rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none";

const input = `w-full ${box}`;

function AgentToggle({
  value,
  onChange,
}: {
  value: AgentName;
  onChange: (a: AgentName) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-zinc-800 bg-zinc-900 p-0.5">
      {(["claude", "codex"] as const).map((a) => (
        <button
          key={a}
          type="button"
          onClick={() => onChange(a)}
          className={`rounded px-3 py-1 text-sm transition ${
            value === a
              ? a === "claude"
                ? "bg-claude/20 text-claude"
                : "bg-codex/20 text-codex"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {a === "claude" ? "Claude" : "Codex"}
        </button>
      ))}
    </div>
  );
}

export default function NewRun({
  onCreated,
}: {
  onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState<Form>(loadForm);
  const [agents, setAgents] = useState<AgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<RoutePreview | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const auto = form.mode === "auto";

  // Rules-only preview (free): what the router will pick for the prompt as typed.
  useEffect(() => {
    const prompt = form.prompt.trim();
    if (!auto || !prompt) return setPreview(null);
    const ctl = new AbortController();
    const t = setTimeout(
      () => api.previewRoute(prompt, ctl.signal).then(setPreview, () => {}),
      400,
    );
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
  }, []);

  useEffect(() => {
    const { prompt: _omit, ...rest } = form;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
    } catch {}
  }, [form]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Auto: the router picks mode, agents and rounds; only manual models are passed through.
      const { maxRounds: _r, judge: _j, coder: _c, ...rest } = form;
      const { id } = await api.create(auto ? rest : form);
      onCreated(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reviewer: AgentName = form.coder === "claude" ? "codex" : "claude";

  return (
    <form
      onSubmit={submit}
      className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-8"
    >
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Phiên mới</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Để <span className="text-claude">Claude</span> và{" "}
          <span className="text-codex">Codex</span> cùng xử lý một vấn đề.
        </p>
        {agents && (
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
            <AgentStatusLine name="claude" version={agents.claude} path={agents.claudePath} error={agents.claudeError} />
            <AgentStatusLine name="codex" version={agents.codex} path={agents.codexPath} error={agents.codexError} />
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() =>
              setForm((f) => ({
                ...f,
                mode: m.id,
                maxRounds: m.id === "pair" ? 3 : 2,
              }))
            }
            className={`rounded-lg border p-4 text-left transition ${
              form.mode === m.id
                ? "border-zinc-500 bg-zinc-900"
                : "border-zinc-800 hover:border-zinc-700"
            }`}
          >
            <div className="font-medium text-zinc-100">{m.title}</div>
            <div className="mt-1 text-xs leading-relaxed text-zinc-500">
              {m.desc}
            </div>
          </button>
        ))}
      </div>

      <Field
        label={
          auto
            ? "Task / câu hỏi"
            : form.mode === "debate"
              ? "Vấn đề / câu hỏi"
              : "Task cần code"
        }
      >
        <textarea
          className={`${input} min-h-40 resize-y leading-relaxed`}
          value={form.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey))
              e.currentTarget.form?.requestSubmit();
          }}
          placeholder={
            auto
              ? "VD: Sửa lỗi đăng nhập bị văng khi token hết hạn — hoặc: So sánh Redis và Memcached cho cache phiên…"
              : form.mode === "debate"
                ? "VD: Thiết kế cơ chế cache cho API tìm kiếm sản phẩm, 10k req/s, dữ liệu thay đổi mỗi 5 phút…"
                : "VD: Thêm endpoint POST /orders/:id/cancel, hoàn kho và ghi log. Viết test cho nó."
          }
          autoFocus
        />
      </Field>

      {auto && preview && <RoutePreviewLine preview={preview} />}

      <Field
        label="Thư mục làm việc"
        hint={
          auto
            ? "Nếu router chọn Pair thì đây phải là git repo (agent sửa file thật, không tự commit); nếu Debate thì chỉ đọc."
            : form.mode === "pair"
              ? "Bắt buộc là git repo. Agent sẽ sửa file thật ở đây (không tự commit)."
              : "Agent chỉ đọc (read-only), để đọc code liên quan."
        }
      >
        <div className="flex gap-2">
          <input
            className={`${input} font-mono`}
            value={form.cwd}
            onChange={(e) => set("cwd", e.target.value)}
            placeholder="C:\path\to\repo"
          />
          {desktop && (
            <button
              type="button"
              onClick={async () => {
                const dir = await desktop.pickFolder(form.cwd);
                if (dir) set("cwd", dir);
              }}
              className="shrink-0 rounded-md border border-zinc-800 px-3 text-sm text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900"
            >
              Chọn…
            </button>
          )}
        </div>
      </Field>

      {!auto && (
        <div className="grid gap-5 sm:grid-cols-2">
          {form.mode === "debate" ? (
            <Field label="Người chốt giải pháp cuối (judge)">
              <AgentToggle
                value={form.judge}
                onChange={(a) => set("judge", a)}
              />
            </Field>
          ) : (
            <Field
              label="Ai code?"
              hint={`${reviewer === "claude" ? "Claude" : "Codex"} sẽ review và chạy test.`}
            >
              <AgentToggle
                value={form.coder}
                onChange={(a) => set("coder", a)}
              />
            </Field>
          )}
          <Field
            label={
              form.mode === "debate"
                ? "Số vòng review chéo tối đa"
                : "Số vòng review tối đa"
            }
          >
            <input
              type="number"
              min={1}
              max={8}
              className={`w-24 ${box}`}
              value={form.maxRounds}
              onChange={(e) => set("maxRounds", Number(e.target.value))}
            />
          </Field>
        </div>
      )}

      <details className="rounded-lg border border-zinc-800 px-4 py-3">
        <summary className="cursor-pointer text-sm text-zinc-400">
          Tùy chọn nâng cao
        </summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {form.mode !== "debate" && (
            <div className="sm:col-span-2">
              <Field
                label="Lệnh test"
                hint="Để trống thì reviewer tự tìm lệnh test/build của project."
              >
                <input
                  className={`${input} font-mono`}
                  value={form.testCommand}
                  onChange={(e) => set("testCommand", e.target.value)}
                  placeholder="pnpm test"
                />
              </Field>
            </div>
          )}
          <Field
            label="Giới hạn mỗi lượt (phút)"
            hint="Quá thời gian này thì lượt của agent bị dừng."
          >
            <input
              type="number"
              min={1}
              max={180}
              className={`w-24 ${box}`}
              value={form.turnTimeoutMin}
              onChange={(e) => set("turnTimeoutMin", Number(e.target.value))}
            />
          </Field>
          <div className="hidden sm:block" />
          <Field
            label="Model Claude"
            hint={
              auto
                ? "Để trống = router tự chọn. Điền thì dùng model này cho mọi lượt của Claude."
                : "VD: opus, sonnet. Để trống = mặc định"
            }
          >
            <input
              className={`${input} font-mono`}
              value={form.models.claude}
              onChange={(e) =>
                set("models", { ...form.models, claude: e.target.value })
              }
            />
          </Field>
          <Field
            label="Model Codex"
            hint={
              auto
                ? "Để trống = router tự chọn (kèm mức reasoning)."
                : "Để trống = mặc định trong config.toml"
            }
          >
            <input
              className={`${input} font-mono`}
              value={form.models.codex}
              onChange={(e) =>
                set("models", { ...form.models, codex: e.target.value })
              }
            />
          </Field>
        </div>
      </details>

      {error && (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || !form.prompt.trim()}
          className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy
            ? auto && preview?.askHaiku
              ? "Đang phân tích task…"
              : "Đang khởi động…"
            : "Bắt đầu"}
        </button>
        <span className="text-xs text-zinc-600">Ctrl + Enter</span>
      </div>
    </form>
  );
}

function AgentStatusLine({
  name,
  version,
  path,
  error,
}: {
  name: AgentName;
  version: string | null;
  path: string | null;
  error: string | null;
}) {
  return (
    <span title={path ?? undefined} className={version ? "text-zinc-500" : "text-red-400"}>
      {name}: {version ?? error ?? "not found in PATH"}
    </span>
  );
}

function RoutePreviewLine({ preview }: { preview: RoutePreview }) {
  const [decision] = preview.route.reason.split("\n");
  return (
    <p className="-mt-3 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs leading-relaxed text-zinc-400">
      {preview.askHaiku ? (
        <>
          <span className="text-zinc-300">Chưa rõ loại task.</span> Khi bấm Bắt
          đầu, Haiku sẽ phân loại trước (~1k token). Tạm đoán: {decision}
        </>
      ) : (
        <>
          <span className="text-zinc-300">Dự kiến:</span> {decision}
        </>
      )}
    </p>
  );
}
