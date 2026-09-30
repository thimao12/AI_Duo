import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { api, type AgentName, type AgentTestResult, type CliDetect, type ModelCatalog } from '../api.ts';
import type { CliDraft, DraftResult, SettingsDraft } from '../cli-settings.ts';
import { btnCls, fieldCls, primaryBtnCls } from './Modal.tsx';
import { effortLabel } from './ModelPicker.tsx';
import { TestResult } from './UsagePanel.tsx';
import { AGENT_LABEL, Spinner } from './ui.tsx';

const SOURCE_LABEL: Record<CliDetect['source'], string> = {
  env: 'biến môi trường',
  settings: 'cài đặt',
  path: 'PATH',
  known: 'vị trí quen thuộc',
  none: 'không tìm thấy',
};

const AGENTS: AgentName[] = ['claude', 'codex'];

/* ---- Small pieces ---------------------------------------------------------- */

interface FieldProps {
  id: string;
  label: string;
  changed: boolean;
  onReset: () => void;
  hint?: string;
  errors?: string[];
  children: ReactNode;
}

function Field({ id, label, changed, onReset, hint, errors = [], children }: Readonly<FieldProps>) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-[12.5px] text-muted">{label}</label>
        {changed && (
          <button type="button" onClick={onReset} className="rounded-md px-1.5 py-0.5 text-[11.5px] text-muted hover:bg-surface hover:text-fg">
            Khôi phục
          </button>
        )}
      </div>
      {children}
      {hint && <p id={`${id}-hint`} className="text-[11.5px] text-faint">{hint}</p>}
      {errors.map((e) => <p key={e} role="alert" className="text-[11.5px] text-danger">{e}</p>)}
    </div>
  );
}

function useDetect(name: AgentName, revision: number) {
  const [detect, setDetect] = useState<CliDetect | null>(null);
  const refresh = useCallback(() => api.detectCli(name).then(setDetect, () => setDetect(null)), [name]);
  useEffect(() => {
    void refresh();
  }, [refresh, revision]);
  return { detect, refresh };
}

function effortOptions(catalog: ModelCatalog | null, name: AgentName, model: string, current: string): string[] {
  const models = catalog?.[name]?.models ?? [];
  const picked = models.find((m) => m.id === model);
  const list = picked ? picked.efforts : [...new Set(models.flatMap((m) => m.efforts))];
  return current && !list.includes(current) ? [...list, current] : list;
}

function statusDot(detect: CliDetect | null): string {
  if (!detect) return 'bg-faint';
  return detect.version ? 'bg-ok' : 'bg-danger';
}

function statusText(detect: CliDetect | null): string {
  if (!detect) return 'đang kiểm tra…';
  return detect.version ?? detect.error ?? 'chưa kết nối';
}

function pathPlaceholder(detect: CliDetect | null): string {
  if (!detect?.resolvedPath) return 'Tự dò từ PATH';
  return `${detect.resolvedPath} (${SOURCE_LABEL[detect.source]})`;
}

/* ---- CLI card -------------------------------------------------------------- */

interface CliCardProps {
  name: AgentName;
  draft: CliDraft;
  baseline: CliDraft;
  envErrors: string[];
  catalog: ModelCatalog | null;
  revision: number;
  dirty: boolean;
  onChange: (patch: Partial<CliDraft>) => void;
}

function CliCardHeader({ name, detect, testing, onTest }: Readonly<{ name: AgentName; detect: CliDetect | null; testing: boolean; onTest: () => void }>) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${statusDot(detect)}`} />
      <output className="min-w-0 flex-1 truncate text-[12px] text-faint" title={detect?.error ?? undefined}>
        <span className="sr-only">{`${AGENT_LABEL[name]}: `}</span>
        {statusText(detect)}
      </output>
      <button type="button" onClick={onTest} disabled={testing} className={`${btnCls} inline-flex items-center gap-1.5`}>
        {testing && <Spinner className="size-3" />}
        Test
      </button>
    </div>
  );
}

type ModelFieldsProps = Pick<CliCardProps, 'name' | 'draft' | 'baseline' | 'catalog' | 'onChange'> & { uid: string };

function CliModelFields({ name, draft, baseline, catalog, uid, onChange }: Readonly<ModelFieldsProps>) {
  const models = catalog?.[name]?.models ?? [];
  const efforts = effortOptions(catalog, name, draft.model, draft.effort);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field id={`${uid}-model`} label="Model mặc định" changed={draft.model !== baseline.model} onReset={() => onChange({ model: baseline.model })}>
        <input id={`${uid}-model`} list={`${uid}-models`} className={fieldCls} value={draft.model} placeholder="Theo CLI" onChange={(e) => onChange({ model: e.target.value })} />
        <datalist id={`${uid}-models`}>
          {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </datalist>
      </Field>
      <Field id={`${uid}-effort`} label="Effort mặc định" changed={draft.effort !== baseline.effort} onReset={() => onChange({ effort: baseline.effort })}>
        <select id={`${uid}-effort`} className={fieldCls} value={draft.effort} onChange={(e) => onChange({ effort: e.target.value })}>
          <option value="">Theo CLI</option>
          {efforts.map((e) => <option key={e} value={e}>{effortLabel(e)}</option>)}
        </select>
      </Field>
    </div>
  );
}

function CliCard(props: Readonly<CliCardProps>) {
  const { name, draft, baseline, envErrors, revision, dirty, onChange } = props;
  const uid = useId();
  const { detect, refresh } = useDetect(name, revision);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AgentTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const runTest = () => {
    setTesting(true);
    setTestError(null);
    api.testAgent(name).then(setResult, (err: Error) => setTestError(err.message)).finally(() => {
      setTesting(false);
      void refresh();
    });
  };

  return (
    <fieldset className="min-w-0 space-y-3 rounded-xl border border-line bg-surface/40 p-4">
      <legend className="px-1.5 text-[13.5px] font-semibold text-fg">{AGENT_LABEL[name]}</legend>
      <CliCardHeader name={name} detect={detect} testing={testing} onTest={runTest} />
      {dirty && <p className="text-[11.5px] text-faint">Test dùng cấu hình đã lưu. Nhấn Lưu trước để áp dụng thay đổi.</p>}
      {result && <TestResult result={result} />}
      {testError && <p role="alert" className="text-[11.5px] text-danger">{testError}</p>}

      <Field id={`${uid}-bin`} label="Đường dẫn CLI" changed={draft.binPath !== baseline.binPath} onReset={() => onChange({ binPath: baseline.binPath })}>
        <input id={`${uid}-bin`} className={`${fieldCls} font-mono text-[12.5px]`} value={draft.binPath} placeholder={pathPlaceholder(detect)} spellCheck={false} onChange={(e) => onChange({ binPath: e.target.value })} />
      </Field>
      <Field id={`${uid}-args`} label="Đối số thêm" changed={draft.args !== baseline.args} onReset={() => onChange({ args: baseline.args })} hint="Mỗi đối số một dòng.">
        <textarea id={`${uid}-args`} aria-describedby={`${uid}-args-hint`} rows={3} className={`${fieldCls} resize-y font-mono text-[12.5px]`} value={draft.args} spellCheck={false} onChange={(e) => onChange({ args: e.target.value })} />
      </Field>
      <Field id={`${uid}-env`} label="Biến môi trường" changed={draft.env !== baseline.env} onReset={() => onChange({ env: baseline.env })} hint="Mỗi dòng một biến, dạng KEY=VALUE." errors={envErrors}>
        <textarea id={`${uid}-env`} aria-describedby={`${uid}-env-hint`} aria-invalid={envErrors.length > 0} rows={3} className={`${fieldCls} resize-y font-mono text-[12.5px]`} value={draft.env} spellCheck={false} onChange={(e) => onChange({ env: e.target.value })} />
      </Field>
      <CliModelFields name={name} draft={draft} baseline={baseline} catalog={props.catalog} uid={uid} onChange={onChange} />
    </fieldset>
  );
}

/* ---- Panel ----------------------------------------------------------------- */

interface CliSettingsPanelProps {
  draft: SettingsDraft;
  baseline: SettingsDraft;
  result: DraftResult;
  dirty: boolean;
  error: string | null;
  busy: boolean;
  revision: number;
  onSave: () => void;
  onCli: (name: AgentName, patch: Partial<CliDraft>) => void;
  onGlobal: (patch: Partial<Pick<SettingsDraft, 'timeout' | 'testCommand'>>) => void;
}

type GlobalFieldsProps = Pick<CliSettingsPanelProps, 'draft' | 'baseline' | 'onGlobal'> & { timeoutError: string | null };

function GlobalFields({ draft, baseline, timeoutError, onGlobal }: Readonly<GlobalFieldsProps>) {
  return (
    <fieldset className="grid min-w-0 gap-3 rounded-xl border border-line p-4 sm:grid-cols-2">
      <legend className="px-1.5 text-[13.5px] font-semibold text-fg">Chung</legend>
      <Field id="cli-timeout" label="Timeout mỗi lượt (phút)" changed={draft.timeout !== baseline.timeout} onReset={() => onGlobal({ timeout: baseline.timeout })} errors={timeoutError ? [timeoutError] : []}>
        <input id="cli-timeout" type="number" min={1} step={1} className={fieldCls} value={draft.timeout} placeholder="Mặc định" onChange={(e) => onGlobal({ timeout: e.target.value })} />
      </Field>
      <Field id="cli-test-command" label="Lệnh test mặc định" changed={draft.testCommand !== baseline.testCommand} onReset={() => onGlobal({ testCommand: baseline.testCommand })}>
        <input id="cli-test-command" className={`${fieldCls} font-mono text-[12.5px]`} value={draft.testCommand} placeholder="vd. pnpm test" spellCheck={false} onChange={(e) => onGlobal({ testCommand: e.target.value })} />
      </Field>
    </fieldset>
  );
}

/** The "CLI" tab: one card per agent plus the global options, saved together. */
export default function CliSettingsPanel({ draft, baseline, result, dirty, error, busy, revision, onSave, onCli, onGlobal }: Readonly<CliSettingsPanelProps>) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  useEffect(() => {
    api.models().then(setCatalog, () => setCatalog(null));
  }, []);

  return (
    <>
      <div className="space-y-4 p-4">
        <p className="text-[12px] text-faint">
          Biến môi trường <code>CLAUDE_BIN</code> và <code>CODEX_BIN</code>, nếu được đặt, sẽ ghi đè đường dẫn CLI cấu hình ở đây.
        </p>
        {AGENTS.map((name) => (
          <CliCard
            key={name}
            name={name}
            draft={draft[name]}
            baseline={baseline[name]}
            envErrors={result.envErrors[name]}
            catalog={catalog}
            revision={revision}
            dirty={dirty}
            onChange={(patch) => onCli(name, patch)}
          />
        ))}
        <GlobalFields draft={draft} baseline={baseline} timeoutError={result.timeoutError} onGlobal={onGlobal} />
      </div>
      <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-line bg-bg px-5 py-3">
        {error && <p role="alert" className="mr-auto min-w-0 text-[12.5px] text-danger">{error}</p>}
        <button type="button" className={primaryBtnCls} disabled={!dirty || busy || !result.valid} onClick={onSave}>Lưu</button>
      </div>
    </>
  );
}
