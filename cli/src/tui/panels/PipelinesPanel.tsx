import { useRef, useState } from 'react';
import { Box, Text, type Key } from 'ink';
import { getPipelines, getRoles, MAX_LOOPS, MAX_STEPS, setPipelines, DEFAULT_MAX_LOOPS } from '../../../../server/src/settings.ts';
import type { PipelineDef, PipelineStep, RoleDef } from '../../../../server/src/types.ts';
import type { PanelProps } from '../panel-types.ts';
import Confirm from '../widgets/Confirm.tsx';
import Panel from '../widgets/Panel.tsx';
import SelectList from '../widgets/SelectList.tsx';
import TextField from '../widgets/TextField.tsx';
import { errText, newId, paint, useLoader } from '../util.ts';

const CLEAR_LABEL = 'Không chạy pipeline';

/** A step with a stable key, since steps have no id of their own. */
export interface DraftStep extends PipelineStep {
  key: string;
}

export interface DraftPipeline {
  id: string;
  name: string;
  steps: DraftStep[];
}

/** Moves step indexes through `map` (old index -> new index, undefined = gone) in every onFail. */
function remapOnFail(steps: DraftStep[], map: (index: number) => number | undefined): DraftStep[] {
  return steps.map((s) => (s.onFail === undefined ? s : { ...s, onFail: map(s.onFail) }));
}

export function moveStep(steps: DraftStep[], from: number, to: number): DraftStep[] {
  if (to < 0 || to >= steps.length) return steps;
  const next = [...steps];
  [next[from], next[to]] = [next[to], next[from]];
  const swap = (i: number) => {
    if (i === from) return to;
    return i === to ? from : i;
  };
  return remapOnFail(next, swap);
}

export function removeStep(steps: DraftStep[], at: number): DraftStep[] {
  const rest = steps.filter((_, i) => i !== at);
  return remapOnFail(rest, (i) => {
    if (i === at) return undefined;
    return i > at ? i - 1 : i;
  });
}

/** What the server accepts: onFail/maxLoops only on gradable steps, and never pointing forward. */
export function toDef(draft: DraftPipeline, roles: readonly RoleDef[]): PipelineDef {
  const steps = draft.steps.map((s, index): PipelineStep => {
    const gradable = roles.find((r) => r.id === s.roleId)?.gradable ?? false;
    if (!gradable) return { roleId: s.roleId };
    const onFail = s.onFail !== undefined && s.onFail <= index ? s.onFail : undefined;
    return onFail === undefined ? { roleId: s.roleId } : { roleId: s.roleId, onFail, maxLoops: s.maxLoops ?? DEFAULT_MAX_LOOPS };
  });
  return { id: draft.id, name: draft.name.trim(), steps };
}

function toDraft(def: PipelineDef, nextKey: () => string): DraftPipeline {
  return { id: def.id, name: def.name, steps: def.steps.map((s) => ({ ...s, key: nextKey() })) };
}

type EditorItem = { kind: 'name' } | { kind: 'step'; step: DraftStep; index: number };

function stepDescription(step: DraftStep, gradable: boolean): string | undefined {
  if (!gradable) return undefined;
  if (step.onFail === undefined) return 'nếu không đạt: dừng pipeline';
  return `nếu không đạt: quay lại bước ${step.onFail + 1}, tối đa ${step.maxLoops ?? DEFAULT_MAX_LOOPS} vòng`;
}

/** Next onFail target for a gradable step: stop, then step 1..index (wrapping back to stop). */
export function nextOnFail(step: DraftStep, index: number): number | undefined {
  if (step.onFail === undefined) return 0;
  return step.onFail >= index ? undefined : step.onFail + 1;
}

interface EditorProps {
  draft: DraftPipeline;
  roles: readonly RoleDef[];
  nextKey: () => string;
  onChange: (draft: DraftPipeline) => void;
  onSave: () => void;
  onCancel: () => void;
}

function useEditorKeys({ draft, roles, nextKey, onChange, onSave }: Readonly<EditorProps>, focusOn: (row: number) => void) {
  const setSteps = (steps: DraftStep[]) => onChange({ ...draft, steps });
  const patch = (at: number, change: Partial<DraftStep>) => setSteps(draft.steps.map((s, i) => (i === at ? { ...s, ...change } : s)));
  const shiftRole = (at: number, delta: number) => {
    const current = roles.findIndex((r) => r.id === draft.steps[at].roleId);
    const next = roles[(current + delta + roles.length) % roles.length];
    if (next) patch(at, { roleId: next.id, onFail: undefined, maxLoops: undefined });
  };
  const move = (at: number, delta: number) => {
    setSteps(moveStep(draft.steps, at, at + delta));
    focusOn(Math.min(Math.max(at + delta, 0), draft.steps.length - 1) + 1);
  };
  const loops = (at: number, delta: number) => {
    const step = draft.steps[at];
    if (step.onFail !== undefined) patch(at, { maxLoops: Math.min(MAX_LOOPS, Math.max(1, (step.maxLoops ?? DEFAULT_MAX_LOOPS) + delta)) });
  };
  const add = () => {
    const first = roles[0];
    if (!first || draft.steps.length >= MAX_STEPS) return;
    setSteps([...draft.steps, { key: nextKey(), roleId: first.id }]);
    focusOn(draft.steps.length + 1);
  };
  const remove = (at: number) => {
    setSteps(removeStep(draft.steps, at));
    focusOn(Math.max(0, at));
  };
  const cycleFail = (at: number) => {
    const step = draft.steps[at];
    if (roles.find((r) => r.id === step.roleId)?.gradable) patch(at, { onFail: nextOnFail(step, at) });
  };

  const onKey = (input: string, key: Key, item: EditorItem | undefined) => {
    if (input === 's') return onSave();
    if (input === 'a') return add();
    if (item?.kind !== 'step') return undefined;
    const at = item.index;
    if (key.leftArrow) shiftRole(at, -1);
    else if (key.rightArrow) shiftRole(at, 1);
    else if (input === 'K') move(at, -1);
    else if (input === 'J') move(at, 1);
    else if (input === 'x') remove(at);
    else if (input === 'f') cycleFail(at);
    else if (input === '+') loops(at, 1);
    else if (input === '-') loops(at, -1);
    return undefined;
  };
  return { onKey, shiftRole };
}

function PipelineEditor(props: Readonly<EditorProps>) {
  const { draft, roles, onChange, onCancel } = props;
  const [editingName, setEditingName] = useState(false);
  const [focus, setFocus] = useState({ row: 0, nonce: 0 });
  const { onKey, shiftRole } = useEditorKeys(props, (row) => setFocus((f) => ({ row, nonce: f.nonce + 1 })));
  const items: EditorItem[] = [{ kind: 'name' }, ...draft.steps.map((step, index): EditorItem => ({ kind: 'step', step, index }))];
  const roleOf = (id: string) => roles.find((r) => r.id === id);

  const label = (item: EditorItem) => {
    if (item.kind === 'name') return 'Tên pipeline';
    const role = roleOf(item.step.roleId);
    const roleLabel = role ? `${role.icon} ${role.name}` : `${item.step.roleId} (đã xoá)`;
    return `${item.index + 1}. ${roleLabel}`;
  };
  const description = (item: EditorItem) => {
    if (item.kind === 'name') return draft.name || 'Chưa đặt tên';
    return stepDescription(item.step, roleOf(item.step.roleId)?.gradable ?? false);
  };

  return (
    <Box flexDirection="column">
      <SelectList
        key={focus.nonce}
        items={items}
        initialIndex={focus.row}
        getKey={(item) => (item.kind === 'name' ? '(name)' : item.step.key)}
        getLabel={label}
        getDescription={description}
        onSelect={(item) => {
          if (item.kind === 'name') setEditingName(true);
          else shiftRole(item.index, 1);
        }}
        onCancel={onCancel}
        onKey={onKey}
        isActive={!editingName}
        maxHeight={9}
        labelWidth={26}
      />
      {editingName ? (
        <Box borderStyle="single" borderColor={paint('yellow')} paddingX={1}>
          <TextField value={draft.name} onChange={(name) => onChange({ ...draft, name })} onSubmit={() => setEditingName(false)} onCancel={() => setEditingName(false)} />
        </Box>
      ) : null}
    </Box>
  );
}

interface ListProps {
  pipelines: readonly PipelineDef[];
  roles: readonly RoleDef[];
  currentId: string | null | undefined;
  onPick: (id: string | null) => void;
  onEdit: (pipeline: PipelineDef) => void;
  onNew: () => void;
  onDelete: (pipeline: PipelineDef) => void;
  onClose: () => void;
}

type ListItem = { kind: 'clear' } | { kind: 'pipeline'; pipeline: PipelineDef };

function PipelineList({ pipelines, roles, currentId, onPick, onEdit, onNew, onDelete, onClose }: Readonly<ListProps>) {
  const items: ListItem[] = [{ kind: 'clear' }, ...pipelines.map((pipeline): ListItem => ({ kind: 'pipeline', pipeline }))];
  const flow = (p: PipelineDef) => p.steps.map((s) => roles.find((r) => r.id === s.roleId)?.name ?? s.roleId).join(' → ');
  const onKey = (input: string, _key: Key, item: ListItem | undefined) => {
    if (input === 'n') onNew();
    else if (item?.kind === 'pipeline' && input === 'e') onEdit(item.pipeline);
    else if (item?.kind === 'pipeline' && input === 'd') onDelete(item.pipeline);
  };
  return (
    <SelectList
      items={items}
      getKey={(item) => (item.kind === 'clear' ? '(none)' : item.pipeline.id)}
      getLabel={(item) => (item.kind === 'clear' ? CLEAR_LABEL : item.pipeline.name)}
      getDescription={(item) => (item.kind === 'clear' ? undefined : `${item.pipeline.steps.length} bước: ${flow(item.pipeline)}`)}
      isCurrent={(item) => (item.kind === 'clear' ? !currentId : item.pipeline.id === currentId)}
      onSelect={(item) => onPick(item.kind === 'clear' ? null : item.pipeline.id)}
      onCancel={onClose}
      onKey={onKey}
      maxHeight={8}
    />
  );
}

type View =
  | { kind: 'list' }
  | { kind: 'edit'; draft: DraftPipeline; isNew: boolean }
  | { kind: 'confirm'; pipeline: PipelineDef };

const LIST_HINTS = [['↑↓', 'chọn'], ['Enter', 'chạy ở tin nhắn tới'], ['n', 'mới'], ['e', 'sửa'], ['d', 'xoá'], ['Esc', 'đóng']] as const;
const EDIT_HINTS = [['←→', 'đổi vai trò'], ['a', 'thêm bước'], ['x', 'xoá bước'], ['K/J', 'lên/xuống'], ['f', 'nhánh lỗi'], ['+/-', 'số vòng'], ['s', 'lưu'], ['Esc', 'quay lại']] as const;

interface BodyProps {
  view: View;
  roles: readonly RoleDef[];
  pipelines: readonly PipelineDef[];
  currentId: string | null | undefined;
  nextKey: () => string;
  setView: (view: View) => void;
  onPick: (id: string | null) => void;
  onClose: () => void;
  onSave: (draft: DraftPipeline, isNew: boolean) => void;
  onDelete: (pipeline: PipelineDef) => void;
  onNew: () => void;
  onBack: () => void;
}

function PipelinesBody({ view, roles, pipelines, currentId, nextKey, setView, onPick, onClose, onSave, onDelete, onNew, onBack }: Readonly<BodyProps>) {
  if (view.kind === 'edit') {
    return <PipelineEditor draft={view.draft} roles={roles} nextKey={nextKey} onChange={(draft) => setView({ ...view, draft })} onSave={() => onSave(view.draft, view.isNew)} onCancel={onBack} />;
  }
  if (view.kind === 'confirm') {
    const target = view.pipeline;
    return <Confirm message={`Xoá pipeline "${target.name}"?`} onYes={() => onDelete(target)} onNo={onBack} />;
  }
  return (
    <PipelineList
      pipelines={pipelines}
      roles={roles}
      currentId={currentId}
      onPick={onPick}
      onEdit={(p) => setView({ kind: 'edit', draft: toDraft(p, nextKey), isNew: false })}
      onNew={onNew}
      onDelete={(p) => setView({ kind: 'confirm', pipeline: p })}
      onClose={onClose}
    />
  );
}

/** Loads roles and pipelines and runs the save/delete calls; a validation string or a rejection becomes `error`. */
function usePipelinesData() {
  const loaded = useLoader(async () => {
    const [roles, pipelines] = await Promise.all([getRoles(), getPipelines()]);
    return { roles, pipelines };
  });
  const [view, setView] = useState<View>({ kind: 'list' });
  const [error, setError] = useState<string | undefined>();
  const counter = useRef(0);
  const nextKey = () => `step-${++counter.current}`;
  const roles = loaded.data?.roles ?? [];
  const pipelines = loaded.data?.pipelines ?? [];

  const persist = async (next: PipelineDef[]) => {
    setError(undefined);
    try {
      const saved = await setPipelines(next);
      if (typeof saved === 'string') {
        setError(saved);
        return;
      }
      loaded.reload();
      setView({ kind: 'list' });
    } catch (err) {
      setError(errText(err));
    }
  };

  const save = (draft: DraftPipeline, isNew: boolean) => {
    if (!draft.name.trim() || draft.steps.length === 0) {
      setError('Mỗi pipeline cần có tên và ít nhất một bước.');
      return;
    }
    const def = toDef(draft, roles);
    void persist(isNew ? [...pipelines, def] : pipelines.map((p) => (p.id === def.id ? def : p)));
  };
  const create = () => {
    const first = roles[0];
    const draft: DraftPipeline = { id: newId('pipeline', pipelines.map((p) => p.id)), name: 'Pipeline mới', steps: first ? [{ key: nextKey(), roleId: first.id }] : [] };
    setView({ kind: 'edit', draft, isNew: true });
  };

  return {
    loaded,
    roles,
    pipelines,
    view,
    setView,
    nextKey,
    save,
    create,
    error: error ?? loaded.error,
    remove: (target: PipelineDef) => void persist(pipelines.filter((p) => p.id !== target.id)),
    back: () => {
      setError(undefined);
      setView({ kind: 'list' });
    },
  };
}

/** /pipelines: pick the pipeline to run with the next message; create, edit and delete pipelines. */
export default function PipelinesPanel({ onClose, onPickPipeline, pipelineId }: Readonly<PanelProps>) {
  const data = usePipelinesData();
  const active = data.pipelines.find((p) => p.id === pipelineId);
  const pick = (id: string | null) => {
    onPickPipeline?.(id);
    onClose();
  };

  return (
    <Panel title="Pipelines" subtitle={active ? `Đang chọn: ${active.name}` : 'Chưa chọn pipeline'} hints={data.view.kind === 'edit' ? EDIT_HINTS : LIST_HINTS} error={data.error} isActive={false}>
      {data.loaded.data ? (
        <PipelinesBody
          view={data.view}
          roles={data.roles}
          pipelines={data.pipelines}
          currentId={pipelineId}
          nextKey={data.nextKey}
          setView={data.setView}
          onPick={pick}
          onClose={onClose}
          onSave={data.save}
          onDelete={data.remove}
          onNew={data.create}
          onBack={data.back}
        />
      ) : (
        <Text color={paint('gray')}>Đang tải…</Text>
      )}
    </Panel>
  );
}
