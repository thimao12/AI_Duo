import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { api, type PipelineDef, type PipelineStep, type RoleDef } from '../api.ts';
import { newId, notifySettingsChanged } from '../roles-data.ts';
import Modal, { btnCls, fieldCls, primaryBtnCls } from './Modal.tsx';

const MAX_STEPS = 12;
const MAX_LOOPS = 10;

/** A step with a stable React key, since steps have no id of their own. */
interface DraftStep extends PipelineStep {
  key: string;
}

interface DraftPipeline {
  id: string;
  name: string;
  steps: DraftStep[];
}

/** Moves step indexes through `map` (old index -> new index, undefined = gone) in every onFail. */
function remapOnFail(steps: DraftStep[], map: (index: number) => number | undefined): DraftStep[] {
  return steps.map((s) => (s.onFail === undefined ? s : { ...s, onFail: map(s.onFail) }));
}

function moveStep(steps: DraftStep[], from: number, to: number): DraftStep[] {
  if (to < 0 || to >= steps.length) return steps;
  const next = [...steps];
  [next[from], next[to]] = [next[to], next[from]];
  const swap = (i: number) => {
    if (i === from) return to;
    return i === to ? from : i;
  };
  return remapOnFail(next, swap);
}

function removeStep(steps: DraftStep[], at: number): DraftStep[] {
  const rest = steps.filter((_, i) => i !== at);
  return remapOnFail(rest, (i) => {
    if (i === at) return undefined;
    return i > at ? i - 1 : i;
  });
}

/** What the server accepts: onFail/maxLoops only on gradable steps, and never pointing forward. */
function toDef(draft: DraftPipeline, roles: readonly RoleDef[]): PipelineDef {
  const steps = draft.steps.map((s, index): PipelineStep => {
    const gradable = roles.find((r) => r.id === s.roleId)?.gradable ?? false;
    if (!gradable) return { roleId: s.roleId };
    const onFail = s.onFail !== undefined && s.onFail <= index ? s.onFail : undefined;
    return { roleId: s.roleId, onFail, maxLoops: onFail === undefined ? undefined : s.maxLoops };
  });
  return { id: draft.id, name: draft.name.trim(), steps };
}

function toDraft(def: PipelineDef, nextKey: () => string): DraftPipeline {
  return { id: def.id, name: def.name, steps: def.steps.map((s) => ({ ...s, key: nextKey() })) };
}

interface StepRowProps {
  step: DraftStep;
  index: number;
  count: number;
  roles: RoleDef[];
  onChange: (patch: Partial<DraftStep>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}

function StepRow({ step, index, count, roles, onChange, onMove, onRemove }: Readonly<StepRowProps>) {
  const role = roles.find((r) => r.id === step.roleId);
  const gradable = role?.gradable ?? false;
  const ids = { role: `step-${step.key}-role`, fail: `step-${step.key}-fail`, loops: `step-${step.key}-loops` };
  const iconBtn = 'grid size-7 place-items-center rounded-md text-muted hover:bg-surface hover:text-fg disabled:opacity-40';
  return (
    <li className="rounded-xl border border-line p-3">
      <div className="flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface text-[12px] font-semibold text-muted">{index + 1}</span>
        <label htmlFor={ids.role} className="sr-only">Vai trò của bước {index + 1}</label>
        <select id={ids.role} value={step.roleId} onChange={(e) => onChange({ roleId: e.target.value })} className={`${fieldCls} min-w-0 flex-1`}>
          {!role && <option value={step.roleId}>{step.roleId} (đã xoá)</option>}
          {roles.map((r) => (
            <option key={r.id} value={r.id}>{r.icon} {r.name}</option>
          ))}
        </select>
        <button type="button" className={iconBtn} disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp aria-hidden className="size-4" />
          <span className="sr-only">Chuyển bước {index + 1} lên</span>
        </button>
        <button type="button" className={iconBtn} disabled={index === count - 1} onClick={() => onMove(1)}>
          <ArrowDown aria-hidden className="size-4" />
          <span className="sr-only">Chuyển bước {index + 1} xuống</span>
        </button>
        <button type="button" className={`${iconBtn} hover:text-danger`} onClick={onRemove}>
          <Trash2 aria-hidden className="size-4" />
          <span className="sr-only">Xoá bước {index + 1}</span>
        </button>
      </div>
      {gradable && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 pl-8 text-[12.5px] text-muted">
          <label htmlFor={ids.fail} className="flex items-center gap-2">
            Nếu không đạt, quay lại{' '}
            <select
              id={ids.fail}
              value={step.onFail ?? ''}
              onChange={(e) => onChange({ onFail: e.target.value === '' ? undefined : Number(e.target.value) })}
              className="h-7 rounded-lg border border-line bg-bg px-1.5 text-[12.5px] text-fg focus:border-focus focus:outline-none"
            >
              <option value="">Dừng pipeline</option>
              {backTargets(index).map((i) => (
                <option key={i} value={i}>Bước {i + 1}</option>
              ))}
            </select>
          </label>
          {step.onFail !== undefined && (
            <label htmlFor={ids.loops} className="flex items-center gap-2">
              Tối đa{' '}
              <input
                id={ids.loops}
                type="number"
                min={1}
                max={MAX_LOOPS}
                value={step.maxLoops ?? 2}
                onChange={(e) => onChange({ maxLoops: Math.min(MAX_LOOPS, Math.max(1, Math.round(Number(e.target.value)) || 1)) })}
                className="h-7 w-16 rounded-lg border border-line bg-bg px-1.5 text-[12.5px] text-fg focus:border-focus focus:outline-none"
              />
              {' '}vòng
            </label>
          )}
        </div>
      )}
    </li>
  );
}

/** Step indexes a step at `index` may loop back to (itself and earlier). */
function backTargets(index: number): number[] {
  return Array.from({ length: index + 1 }, (_, i) => i);
}

interface PipelineFormProps {
  pipeline: DraftPipeline;
  roles: RoleDef[];
  onChange: (next: DraftPipeline) => void;
  onDelete: () => void;
  nextKey: () => string;
}

function PipelineForm({ pipeline, roles, onChange, onDelete, nextKey }: Readonly<PipelineFormProps>) {
  const setSteps = (list: DraftStep[]) => onChange({ ...pipeline, steps: list });
  const patchStep = (key: string, patch: Partial<DraftStep>) => setSteps(pipeline.steps.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const addStep = () => {
    const roleId = roles[0]?.id;
    if (roleId) setSteps([...pipeline.steps, { key: nextKey(), roleId }]);
  };
  return (
    <div className="min-w-0 flex-1 space-y-4 p-4">
      <label className="block space-y-1">
        <span className="text-[12.5px] text-muted">Tên pipeline</span>
        <input className={fieldCls} maxLength={60} value={pipeline.name} onChange={(e) => onChange({ ...pipeline, name: e.target.value })} />
      </label>

      <div>
        <h3 className="mb-2 text-[12.5px] font-medium text-muted">Các bước (chạy từ trên xuống)</h3>
        <ol className="space-y-2">
          {pipeline.steps.map((s, i) => (
            <StepRow
              key={s.key}
              step={s}
              index={i}
              count={pipeline.steps.length}
              roles={roles}
              onChange={(patch) => patchStep(s.key, patch)}
              onMove={(delta) => setSteps(moveStep(pipeline.steps, i, i + delta))}
              onRemove={() => setSteps(removeStep(pipeline.steps, i))}
            />
          ))}
        </ol>
        <button type="button" onClick={addStep} disabled={pipeline.steps.length >= MAX_STEPS || roles.length === 0} className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] text-muted hover:bg-surface hover:text-fg disabled:opacity-50">
          <Plus aria-hidden className="size-4" />
          Thêm bước
        </button>
      </div>

      <button type="button" onClick={onDelete} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] text-danger hover:bg-surface">
        <Trash2 aria-hidden className="size-3.5" />
        Xoá pipeline
      </button>
    </div>
  );
}

function PipelineList({ items, selectedId, onSelect, onAdd }: Readonly<{ items: DraftPipeline[]; selectedId: string; onSelect: (id: string) => void; onAdd: () => void }>) {
  return (
    <nav aria-label="Danh sách pipeline" className="flex w-full shrink-0 flex-col gap-0.5 border-b border-line p-2 sm:w-56 sm:border-r sm:border-b-0">
      {items.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-current={p.id === selectedId ? 'true' : undefined}
          onClick={() => onSelect(p.id)}
          className={`rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface ${p.id === selectedId ? 'bg-surface' : ''}`}
        >
          <span className="block truncate text-[13px] font-medium text-fg">{p.name || 'Chưa đặt tên'}</span>
          <span className="block text-[11.5px] text-faint">{p.steps.length} bước</span>
        </button>
      ))}
      <button type="button" onClick={onAdd} className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-muted hover:bg-surface hover:text-fg">
        <Plus aria-hidden className="size-4" />
        Thêm pipeline
      </button>
    </nav>
  );
}

function usePipelinesEditor(open: boolean) {
  const [items, setItems] = useState<DraftPipeline[]>([]);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const counter = useRef(0);
  const nextKey = () => `k${++counter.current}`;

  useEffect(() => {
    if (!open) return;
    setError(null);
    Promise.all([api.roles(), api.pipelines()]).then(([r, p]) => {
      setRoles(r.roles);
      setItems(p.pipelines.map((def) => toDraft(def, nextKey)));
      setSelectedId(p.pipelines[0]?.id ?? '');
    }, (err: Error) => setError(err.message));
  }, [open]);

  const replace = (next: DraftPipeline) => setItems((list) => list.map((p) => (p.id === next.id ? next : p)));

  const add = () => {
    const draft: DraftPipeline = {
      id: newId('pipeline', items.map((p) => p.id)),
      name: 'Pipeline mới',
      steps: roles[0] ? [{ key: nextKey(), roleId: roles[0].id }] : [],
    };
    setItems((list) => [...list, draft]);
    setSelectedId(draft.id);
  };

  const remove = () => {
    const rest = items.filter((p) => p.id !== selectedId);
    setItems(rest);
    setSelectedId(rest[0]?.id ?? '');
  };

  const save = async (): Promise<boolean> => {
    const empty = items.find((p) => !p.name.trim() || p.steps.length === 0);
    if (empty) {
      setSelectedId(empty.id);
      setError('Mỗi pipeline cần có tên và ít nhất một bước.');
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      await api.savePipelines(items.map((p) => toDef(p, roles)));
      notifySettingsChanged();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { items, roles, selectedId, setSelectedId, error, busy, nextKey, replace, add, remove, save };
}

/** Pipelines editor body with its own action bar; `onClose` (modal use) adds a Đóng button and closes after saving. */
export function PipelinesPanel({ active = true, onClose }: Readonly<{ active?: boolean; onClose?: () => void }>) {
  const ed = usePipelinesEditor(active);
  const current = ed.items.find((p) => p.id === ed.selectedId);

  const saveAndClose = async () => {
    if (await ed.save() && onClose) onClose();
  };

  return (
    <>
      <div className="flex flex-col sm:flex-row">
        <PipelineList items={ed.items} selectedId={ed.selectedId} onSelect={ed.setSelectedId} onAdd={ed.add} />
        {current ? (
          <PipelineForm key={current.id} pipeline={current} roles={ed.roles} onChange={ed.replace} onDelete={ed.remove} nextKey={ed.nextKey} />
        ) : (
          <p className="p-4 text-[13px] text-faint">Chưa có pipeline nào. Nhấn Thêm pipeline để tạo.</p>
        )}
      </div>
      <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-line bg-bg px-5 py-3">
        {ed.error && <p role="alert" className="mr-auto min-w-0 text-[12.5px] text-danger">{ed.error}</p>}
        {onClose && <button type="button" className={btnCls} onClick={onClose}>Đóng</button>}
        <button type="button" className={primaryBtnCls} disabled={ed.busy} onClick={() => void saveAndClose()}>Lưu</button>
      </div>
    </>
  );
}

/** Create, edit and delete pipelines: an ordered list of role steps with pass/fail loops. */
export function PipelinesModal({ open, onClose }: Readonly<{ open: boolean; onClose: () => void }>) {
  return (
    <Modal open={open} onClose={onClose} title="Pipelines" width="max-w-4xl">
      <PipelinesPanel active={open} onClose={onClose} />
    </Modal>
  );
}

export default PipelinesModal;
