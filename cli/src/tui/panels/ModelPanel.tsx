import { useState } from 'react';
import type { AgentName } from '../../../../server/src/agents/types.ts';
import type { ModelCatalog } from '../../../../server/src/types.ts';
import type { PanelProps, SessionOverrides } from '../panel-types.ts';
import { effortsFor, modelIds, safeCatalog, withCurrent } from '../util.ts';
import Form, { type FormField } from '../widgets/Form.tsx';
import Panel from '../widgets/Panel.tsx';

const AGENT_LABEL: Record<AgentName, string> = { claude: 'Claude', codex: 'Codex' };
const PERMISSION_LABEL = { read: 'Chỉ đọc', edit: 'Sửa file' } as const;

/** Text values of the form: '' means "not overridden". */
export interface ModelDraft {
  agent: AgentName | '';
  model: string;
  effort: string;
  permission: 'read' | 'edit' | '';
}

export const toDraft = (overrides: SessionOverrides | undefined): ModelDraft => ({
  agent: overrides?.agent ?? '',
  model: overrides?.model ?? '',
  effort: overrides?.effort ?? '',
  permission: overrides?.permission ?? '',
});

/** Only the fields the user actually set. */
export function toOverrides(draft: ModelDraft): SessionOverrides {
  const next: SessionOverrides = {};
  if (draft.agent) {
    next.agent = draft.agent;
    if (draft.model) next.model = draft.model;
    if (draft.effort) next.effort = draft.effort;
  }
  if (draft.permission) next.permission = draft.permission;
  return next;
}

/** "Claude · opus · high · Chỉ đọc", or a note that nothing is overridden. */
export function describeOverrides(overrides: SessionOverrides | undefined): string {
  if (!overrides) return 'tự động (không ghi đè)';
  const parts = [overrides.agent ? AGENT_LABEL[overrides.agent] : undefined, overrides.model, overrides.effort, overrides.permission ? PERMISSION_LABEL[overrides.permission] : undefined];
  const shown = parts.filter(Boolean);
  return shown.length > 0 ? shown.join(' · ') : 'tự động (không ghi đè)';
}

export function modelFields(draft: ModelDraft, catalog: ModelCatalog): FormField[] {
  const fields: FormField[] = [
    { id: 'agent', label: 'Agent', kind: 'cycle', value: draft.agent, options: ['', 'claude', 'codex'], optionLabels: ['Tự động', 'Claude', 'Codex'] },
  ];
  if (draft.agent) {
    const models = modelIds(catalog, draft.agent);
    const efforts = effortsFor(catalog, draft.agent, draft.model);
    fields.push(
      { id: 'model', label: 'Model', kind: 'cycle', editable: true, value: draft.model, options: withCurrent(models, draft.model), placeholder: 'mặc định', hint: `←/→ đổi · Enter gõ tên khác. Gợi ý: ${models.join(', ') || 'không có'}` },
      { id: 'effort', label: 'Effort', kind: 'cycle', editable: true, value: draft.effort, options: withCurrent(efforts, draft.effort), placeholder: 'mặc định', hint: `←/→ đổi · Enter gõ giá trị khác. Gợi ý: ${efforts.join(', ') || 'không có'}` },
    );
  }
  fields.push({ id: 'permission', label: 'Quyền', kind: 'cycle', value: draft.permission, options: ['', 'read', 'edit'], optionLabels: ['Theo vai trò / mặc định', PERMISSION_LABEL.read, PERMISSION_LABEL.edit] });
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
    default:
      return draft;
  }
}

/** /model: choose agent, model, effort and permission for the next messages. */
export default function ModelPanel({ onClose, onPickOverrides, overrides }: Readonly<PanelProps>) {
  const [catalog] = useState(safeCatalog);
  const [draft, setDraft] = useState(() => toDraft(overrides));
  const apply = (next: SessionOverrides) => {
    onPickOverrides?.(next);
    onClose();
  };

  return (
    <Panel title="Model & quyền" subtitle={`Hiện tại: ${describeOverrides(overrides)}`} hints={[['↑↓', 'chọn'], ['←→', 'đổi'], ['Enter', 'gõ tay'], ['s', 'áp dụng'], ['x', 'xoá ghi đè'], ['Esc', 'đóng']]}>
      <Form
        fields={modelFields(draft, catalog)}
        onChange={(id, value) => setDraft((d) => changeDraft(d, id, value, catalog))}
        onSave={() => apply(toOverrides(draft))}
        onCancel={onClose}
        onKey={(input) => {
          if (input === 'x') apply({});
        }}
      />
    </Panel>
  );
}
