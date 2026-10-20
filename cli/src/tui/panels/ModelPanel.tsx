import { useEffect, useState } from 'react';
import { refreshModels } from '../../../../server/src/models.ts';
import type { AgentName } from '../../../../server/src/agents/types.ts';
import type { ModelCatalog } from '../../../../server/src/types.ts';
import type { PanelProps, SessionOverrides } from '../panel-types.ts';
import { effortsFor, modelIds, safeCatalog, withCurrent } from '../util.ts';
import Form, { type FormField } from '../widgets/Form.tsx';
import Panel from '../widgets/Panel.tsx';

const AGENT_LABEL: Record<AgentName, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
const PERMISSION_LABEL = { read: 'Chỉ đọc', edit: 'Sửa file' } as const;
const AGENT_OPTIONS = ['', 'claude', 'codex', 'antigravity'];

/** The model value that leaves the choice of model to the router (it picks the one that fits the task). */
export const AUTO_MODEL = 'auto';

/** Labels of a model field's options, in order: the CLI default, "auto", then each model by name. */
function modelLabels(options: readonly string[], catalog: ModelCatalog, agent: AgentName): string[] {
  return options.map((id) => {
    if (id === '') return 'mặc định của CLI';
    if (id === AUTO_MODEL) return 'Tự động (theo task)';
    const name = catalog[agent].models.find((m) => m.id === id)?.name;
    return name && name !== id ? `${name} (${id})` : id;
  });
}

/** Text values of the form: '' means "not overridden". */
export interface ModelDraft {
  agent: AgentName | '';
  reviewer: AgentName | '';
  model: string;
  effort: string;
  permission: 'read' | 'edit' | '';
}

export const toDraft = (overrides: SessionOverrides | undefined): ModelDraft => ({
  agent: overrides?.agent ?? '',
  reviewer: overrides?.reviewer ?? '',
  model: overrides?.model ?? '',
  effort: overrides?.effort ?? '',
  permission: overrides?.permission ?? '',
});

/** Only the fields the user actually set; no agent at all means "Tự động" was picked (follow-ups are routed again). */
export function toOverrides(draft: ModelDraft): SessionOverrides {
  const next: SessionOverrides = {};
  if (draft.agent) {
    next.agent = draft.agent;
    if (draft.model) next.model = draft.model;
    if (draft.effort) next.effort = draft.effort;
  }
  if (draft.reviewer) next.reviewer = draft.reviewer;
  if (!draft.agent && !draft.reviewer) next.auto = true;
  if (draft.permission) next.permission = draft.permission;
  return next;
}

/** "Claude · opus · high · Chỉ đọc", or a note that nothing is overridden. */
export function describeOverrides(overrides: SessionOverrides | undefined): string {
  if (!overrides) return 'tự động (không ghi đè)';
  const parts = [
    overrides.agent ? AGENT_LABEL[overrides.agent] : undefined,
    overrides.model === AUTO_MODEL ? 'model tự động' : overrides.model,
    overrides.effort,
    overrides.reviewer ? `review: ${AGENT_LABEL[overrides.reviewer]}` : undefined,
    overrides.permission ? PERMISSION_LABEL[overrides.permission] : undefined,
  ];
  const shown = parts.filter(Boolean);
  return shown.length > 0 ? shown.join(' · ') : 'tự động (không ghi đè)';
}

export function modelFields(draft: ModelDraft, catalog: ModelCatalog): FormField[] {
  const fields: FormField[] = [
    { id: 'agent', label: 'Agent', kind: 'cycle', value: draft.agent, options: AGENT_OPTIONS, optionLabels: ['Tự động', 'Claude', 'Codex', 'Antigravity'], hint: 'Code: agent viết code · Plan: agent lập kế hoạch. Tự động: router chọn cả agent lẫn model theo task.' },
  ];
  if (draft.agent) {
    const models = modelIds(catalog, draft.agent);
    const efforts = effortsFor(catalog, draft.agent, draft.model);
    const modelOptions = withCurrent([AUTO_MODEL, ...models], draft.model);
    fields.push(
      { id: 'model', label: 'Model', kind: 'cycle', editable: true, value: draft.model, options: modelOptions, optionLabels: modelLabels(modelOptions, catalog, draft.agent), placeholder: 'mặc định', hint: `←/→ đổi · Enter gõ tên khác · "Tự động" để router chọn model hợp task. Có sẵn: ${models.join(', ') || 'không có'}` },
      { id: 'effort', label: 'Effort', kind: 'cycle', editable: true, value: draft.effort, options: withCurrent(efforts, draft.effort), placeholder: 'mặc định', hint: `←/→ đổi · Enter gõ giá trị khác. Gợi ý: ${efforts.join(', ') || 'không có'}` },
    );
  }
  fields.push(
    { id: 'permission', label: 'Quyền', kind: 'cycle', value: draft.permission, options: ['', 'read', 'edit'], optionLabels: ['Theo vai trò / mặc định', PERMISSION_LABEL.read, PERMISSION_LABEL.edit] },
    { id: 'reviewer', label: 'Reviewer', kind: 'cycle', value: draft.reviewer, options: AGENT_OPTIONS, optionLabels: ['Mặc định', 'Claude', 'Codex', 'Antigravity'], hint: 'Agent review của Code/Plan. Mặc định: Plan tự review, Code dùng cặp Claude ↔ Codex (Antigravity ↔ Claude).' },
  );
  return fields;
}

export function changeDraft(draft: ModelDraft, id: string, value: string, catalog: ModelCatalog): ModelDraft {
  switch (id) {
    case 'agent':
      return value === draft.agent ? draft : { ...draft, agent: value as ModelDraft['agent'], model: '', effort: '' };
    case 'model': {
      const keep = draft.effort === '' || draft.agent === '' || effortsFor(catalog, draft.agent, value).includes(draft.effort);
      return { ...draft, model: value, effort: keep ? draft.effort : '' };
    }
    case 'effort':
      return { ...draft, effort: value };
    case 'permission':
      return { ...draft, permission: value as ModelDraft['permission'] };
    case 'reviewer':
      return { ...draft, reviewer: value as ModelDraft['reviewer'] };
    default:
      return draft;
  }
}

/** /model: choose agent, model, effort and permission for the next messages. */
export default function ModelPanel({ onClose, onPickOverrides, overrides, modeLabel, modeId }: Readonly<PanelProps>) {
  const [catalog, setCatalog] = useState(safeCatalog);
  // The CLIs are asked what they offer now (Antigravity lists its models on request); the saved lists show meanwhile.
  useEffect(() => {
    let live = true;
    refreshModels().then((fresh) => live && setCatalog(fresh), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  const [draft, setDraft] = useState(() => toDraft(overrides));
  const apply = (next: SessionOverrides) => {
    onPickOverrides?.(next);
    onClose();
  };

  return (
    <Panel title={modeLabel ? `Model & quyền · ${modeLabel}` : 'Model & quyền'} subtitle={`Hiện tại: ${describeOverrides(overrides)}${modeId?.startsWith('pipeline:') ? ' · pipeline: model từng bước theo role (/roles)' : ''}`} hints={[['↑↓', 'chọn'], ['←→', 'đổi'], ['Enter', 'gõ tay'], ['s', 'áp dụng'], ['x', 'xoá ghi đè'], ['Esc', 'đóng']]}>
      <Form
        fields={modelFields(draft, catalog)}
        onChange={(id, value) => setDraft((d) => changeDraft(d, id, value, catalog))}
        onSave={() => apply(toOverrides(draft))}
        onCancel={onClose}
        onKey={(input) => {
          if (input === 'x') apply({ auto: true });
        }}
      />
    </Panel>
  );
}
