import { useState } from 'react';
import { Box, Text } from 'ink';
import type { AgentName } from '../../../../server/src/agents/types.ts';
import { getRoles, resetRoles, setRoles } from '../../../../server/src/settings.ts';
import type { ModelCatalog, RoleDef } from '../../../../server/src/types.ts';
import type { PanelProps } from '../panel-types.ts';
import Confirm from '../widgets/Confirm.tsx';
import Form, { type FormField } from '../widgets/Form.tsx';
import Panel from '../widgets/Panel.tsx';
import SelectList from '../widgets/SelectList.tsx';
import { effortsFor, errText, modelIds, newId, paint, safeCatalog, useLoader, withCurrent } from '../util.ts';

const NONE_LABEL = 'Không dùng vai trò (tự động)';
const PERMISSION_LABEL = { read: 'Chỉ đọc', edit: 'Sửa file' } as const;

type Item = { kind: 'none' } | { kind: 'role'; role: RoleDef };

type View =
  | { kind: 'list' }
  | { kind: 'form'; draft: RoleDef; isNew: boolean }
  | { kind: 'confirm'; action: 'delete' | 'reset'; role?: RoleDef };

export function blankRole(taken: readonly string[]): RoleDef {
  return {
    id: newId('role', taken),
    name: 'Vai trò mới',
    icon: '⭐',
    description: '',
    agent: 'claude',
    model: '',
    effort: '',
    permission: 'read',
    template: '{{task}}',
    gradable: false,
  };
}

/** The form's fields for a draft role; model and effort suggestions come from the catalog. */
export function roleFields(role: RoleDef, catalog: ModelCatalog): FormField[] {
  const models = modelIds(catalog, role.agent);
  const efforts = effortsFor(catalog, role.agent, role.model);
  return [
    { id: 'icon', label: 'Icon', kind: 'text', value: role.icon },
    { id: 'name', label: 'Tên', kind: 'text', value: role.name },
    { id: 'description', label: 'Mô tả', kind: 'text', value: role.description },
    { id: 'agent', label: 'Agent', kind: 'cycle', value: role.agent, options: ['claude', 'codex'], optionLabels: ['Claude', 'Codex'] },
    {
      id: 'model',
      label: 'Model',
      kind: 'cycle',
      editable: true,
      value: role.model,
      options: withCurrent(models, role.model),
      placeholder: 'mặc định',
      hint: `←/→ đổi · Enter gõ tên khác. Gợi ý: ${models.join(', ') || 'không có'}`,
    },
    {
      id: 'effort',
      label: 'Effort',
      kind: 'cycle',
      editable: true,
      value: role.effort,
      options: withCurrent(efforts, role.effort),
      placeholder: 'mặc định',
      hint: `←/→ đổi · Enter gõ giá trị khác. Gợi ý: ${efforts.join(', ') || 'không có'}`,
    },
    { id: 'permission', label: 'Quyền mặc định', kind: 'cycle', value: role.permission, options: ['read', 'edit'], optionLabels: [PERMISSION_LABEL.read, PERMISSION_LABEL.edit] },
    { id: 'gradable', label: 'Chấm đạt/chưa đạt', kind: 'cycle', value: role.gradable ? 'yes' : 'no', options: ['no', 'yes'], optionLabels: ['Không', 'Có (nhánh pass/fail trong pipeline)'] },
    { id: 'template', label: 'Prompt mẫu', kind: 'multiline', value: role.template, hint: 'Biến: {{task}}, {{prev}}, {{Tên bước}}' },
  ];
}

/** The draft after the user changed one field (changing agent clears model and effort). */
export function changeRole(role: RoleDef, id: string, value: string, catalog: ModelCatalog): RoleDef {
  switch (id) {
    case 'agent':
      return value === role.agent ? role : { ...role, agent: value as AgentName, model: '', effort: '' };
    case 'model': {
      const keep = role.effort === '' || effortsFor(catalog, role.agent, value).includes(role.effort);
      return { ...role, model: value, effort: keep ? role.effort : '' };
    }
    case 'permission':
      return { ...role, permission: value === 'edit' ? 'edit' : 'read' };
    case 'gradable':
      return { ...role, gradable: value === 'yes' };
    case 'icon':
    case 'name':
    case 'description':
    case 'effort':
    case 'template':
      return { ...role, [id]: value };
    default:
      return role;
  }
}

const summary = (role: RoleDef): string =>
  [role.agent === 'claude' ? 'Claude' : 'Codex', role.model || 'mặc định', role.effort || 'mặc định', PERMISSION_LABEL[role.permission]].join(' · ');

interface ListProps {
  roles: readonly RoleDef[];
  current: RoleDef | null | undefined;
  onPick: (role: RoleDef | null) => void;
  onEdit: (role: RoleDef) => void;
  onNew: () => void;
  onDelete: (role: RoleDef) => void;
  onReset: () => void;
  onClose: () => void;
}

function RoleList({ roles, current, onPick, onEdit, onNew, onDelete, onReset, onClose }: Readonly<ListProps>) {
  const [shown, setShown] = useState<Item | undefined>();
  const items: Item[] = [{ kind: 'none' }, ...roles.map((role): Item => ({ kind: 'role', role }))];
  const onKey = (input: string, _key: unknown, item: Item | undefined) => {
    if (input === 'n') onNew();
    else if (input === 'r') onReset();
    else if (item?.kind === 'role' && input === 'e') onEdit(item.role);
    else if (item?.kind === 'role' && input === 'd') onDelete(item.role);
  };
  return (
    <Box flexDirection="column">
      <SelectList
        items={items}
        getKey={(item) => (item.kind === 'none' ? '(none)' : item.role.id)}
        getLabel={(item) => (item.kind === 'none' ? NONE_LABEL : `${item.role.icon} ${item.role.name}`)}
        getDescription={(item) => (item.kind === 'none' ? undefined : summary(item.role))}
        isCurrent={(item) => (item.kind === 'none' ? !current : item.role.id === current?.id)}
        onSelect={(item) => onPick(item.kind === 'none' ? null : item.role)}
        onCancel={onClose}
        onHighlight={setShown}
        onKey={onKey}
        maxHeight={8}
      />
      {shown?.kind === 'role' && shown.role.description ? <Text dimColor>{shown.role.description}</Text> : null}
    </Box>
  );
}

interface FormViewProps {
  draft: RoleDef;
  catalog: ModelCatalog;
  onChange: (role: RoleDef) => void;
  onSave: () => void;
  onCancel: () => void;
}

function RoleForm({ draft, catalog, onChange, onSave, onCancel }: Readonly<FormViewProps>) {
  return (
    <Form
      fields={roleFields(draft, catalog)}
      onChange={(id, value) => onChange(changeRole(draft, id, value, catalog))}
      onSave={onSave}
      onCancel={onCancel}
      maxRows={9}
    />
  );
}

const LIST_HINTS = [['↑↓', 'chọn'], ['Enter', 'dùng cho tin nhắn tới'], ['e', 'sửa'], ['n', 'mới'], ['d', 'xoá'], ['r', 'mặc định'], ['Esc', 'đóng']] as const;
const FORM_HINTS = [['↑↓', 'chọn ô'], ['Enter', 'sửa'], ['←→', 'đổi'], ['s', 'lưu'], ['Esc', 'quay lại']] as const;

function confirmText(view: Extract<View, { kind: 'confirm' }>): string {
  return view.action === 'reset' ? 'Khôi phục các vai trò mặc định? Vai trò tuỳ chỉnh không dùng trong pipeline sẽ bị xoá.' : `Xoá vai trò "${view.role?.name ?? ''}"?`;
}

interface BodyProps {
  view: View;
  roles: readonly RoleDef[];
  catalog: ModelCatalog;
  current: RoleDef | null | undefined;
  setView: (view: View) => void;
  onPick: (role: RoleDef | null) => void;
  onClose: () => void;
  onSaveDraft: (draft: RoleDef, isNew: boolean) => void;
  onConfirmed: (view: Extract<View, { kind: 'confirm' }>) => void;
  onBack: () => void;
}

function RolesBody({ view, roles, catalog, current, setView, onPick, onClose, onSaveDraft, onConfirmed, onBack }: Readonly<BodyProps>) {
  if (view.kind === 'form') {
    return <RoleForm draft={view.draft} catalog={catalog} onChange={(next) => setView({ ...view, draft: next })} onSave={() => onSaveDraft(view.draft, view.isNew)} onCancel={onBack} />;
  }
  if (view.kind === 'confirm') return <Confirm message={confirmText(view)} onYes={() => onConfirmed(view)} onNo={onBack} />;
  return (
    <RoleList
      roles={roles}
      current={current}
      onPick={onPick}
      onEdit={(r) => setView({ kind: 'form', draft: r, isNew: false })}
      onNew={() => setView({ kind: 'form', draft: blankRole(roles.map((r) => r.id)), isNew: true })}
      onDelete={(r) => setView({ kind: 'confirm', action: 'delete', role: r })}
      onReset={() => setView({ kind: 'confirm', action: 'reset' })}
      onClose={onClose}
    />
  );
}

/** Loads the roles and runs the save/delete/reset calls; a returned validation string or a rejection becomes `error`. */
function useRolesData() {
  const loaded = useLoader(() => getRoles());
  const [view, setView] = useState<View>({ kind: 'list' });
  const [error, setError] = useState<string | undefined>();
  const roles = loaded.data ?? [];

  const persist = async (call: () => Promise<RoleDef[] | string>) => {
    setError(undefined);
    try {
      const saved = await call();
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

  return {
    loaded,
    roles,
    view,
    setView,
    error: error ?? loaded.error,
    saveDraft: (draft: RoleDef, isNew: boolean) => void persist(() => setRoles(isNew ? [...roles, draft] : roles.map((r) => (r.id === draft.id ? draft : r)))),
    confirmed: (v: Extract<View, { kind: 'confirm' }>) => void persist(() => (v.action === 'reset' ? resetRoles() : setRoles(roles.filter((r) => r.id !== v.role?.id)))),
    back: () => {
      setError(undefined);
      setView({ kind: 'list' });
    },
  };
}

/** /roles: pick the role for the next message, edit, add, delete or reset the role list. */
export default function RolesPanel({ onClose, onPickRole, role }: Readonly<PanelProps>) {
  const data = useRolesData();
  const [catalog] = useState(safeCatalog);
  const pick = (picked: RoleDef | null) => {
    onPickRole?.(picked);
    onClose();
  };
  const subtitle = role ? `Đang dùng: ${role.icon} ${role.name}` : 'Chưa chọn vai trò: agent tự động';

  return (
    <Panel title="Vai trò" subtitle={subtitle} hints={data.view.kind === 'form' ? FORM_HINTS : LIST_HINTS} error={data.error} isActive={false}>
      {data.loaded.data ? (
        <RolesBody
          view={data.view}
          roles={data.roles}
          catalog={catalog}
          current={role}
          setView={data.setView}
          onPick={pick}
          onClose={onClose}
          onSaveDraft={data.saveDraft}
          onConfirmed={data.confirmed}
          onBack={data.back}
        />
      ) : (
        <Text color={paint('gray')}>Đang tải…</Text>
      )}
    </Panel>
  );
}
