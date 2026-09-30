import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, type AgentName, type ModelCatalog, type RoleDef } from '../api.ts';
import { newId, notifySettingsChanged } from '../roles-data.ts';
import ModelPicker from './ModelPicker.tsx';
import Modal, { btnCls, fieldCls, primaryBtnCls } from './Modal.tsx';
import { AgentToggle, PermissionSelect } from './role-controls.tsx';
import { AgentDot } from './ui.tsx';

function blankRole(taken: readonly string[]): RoleDef {
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

function RoleList({ roles, selectedId, onSelect, onAdd }: Readonly<{ roles: RoleDef[]; selectedId: string; onSelect: (id: string) => void; onAdd: () => void }>) {
  return (
    <nav aria-label="Danh sách vai trò" className="flex w-full shrink-0 flex-col gap-0.5 border-b border-line p-2 sm:w-56 sm:border-r sm:border-b-0">
      {roles.map((r) => (
        <button
          key={r.id}
          type="button"
          aria-current={r.id === selectedId ? 'true' : undefined}
          onClick={() => onSelect(r.id)}
          className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface ${r.id === selectedId ? 'bg-surface' : ''}`}
        >
          <span aria-hidden className="w-5 shrink-0 text-center text-[14.5px]">{r.icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-fg">{r.name}</span>
            <span className="flex items-center gap-1.5 text-[11.5px] text-faint">
              <AgentDot agent={r.agent} />
              <span className="truncate">{r.model || 'mặc định'}{r.effort ? ` · ${r.effort}` : ''}</span>
            </span>
          </span>
        </button>
      ))}
      <button type="button" onClick={onAdd} className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-muted hover:bg-surface hover:text-fg">
        <Plus aria-hidden className="size-4" />
        Thêm vai trò
      </button>
    </nav>
  );
}

interface RoleFormProps {
  role: RoleDef;
  catalog: ModelCatalog | null;
  canDelete: boolean;
  onChange: (patch: Partial<RoleDef>) => void;
  onDelete: () => void;
}

function RoleForm({ role, catalog, canDelete, onChange, onDelete }: Readonly<RoleFormProps>) {
  const pickAgent = (agent: AgentName | '') => {
    if (agent && agent !== role.agent) onChange({ agent, model: '', effort: '' });
  };
  return (
    <div className="min-w-0 flex-1 space-y-4 p-4">
      <div className="flex gap-3">
        <label className="block w-20 shrink-0 space-y-1">
          <span className="text-[12.5px] text-muted">Icon</span>
          <input className={`${fieldCls} text-center`} maxLength={8} value={role.icon} onChange={(e) => onChange({ icon: e.target.value })} />
        </label>
        <label className="block min-w-0 flex-1 space-y-1">
          <span className="text-[12.5px] text-muted">Tên</span>
          <input className={fieldCls} maxLength={40} value={role.name} onChange={(e) => onChange({ name: e.target.value })} />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-[12.5px] text-muted">Mô tả</span>
        <input className={fieldCls} maxLength={300} value={role.description} onChange={(e) => onChange({ description: e.target.value })} />
      </label>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="space-y-1">
          <span className="block text-[12.5px] text-muted">Agent</span>
          <AgentToggle label="Agent của vai trò" value={role.agent} onChange={pickAgent} />
        </div>
        <div className="space-y-1">
          <span className="block text-[12.5px] text-muted">Model · Effort</span>
          <ModelPicker
            agent={role.agent}
            catalog={catalog}
            model={role.model}
            effort={role.effort}
            auto={false}
            side="bottom"
            onChange={({ model, effort }) => onChange({ model, effort })}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="role-permission" className="block text-[12.5px] text-muted">Quyền mặc định</label>
          <PermissionSelect id="role-permission" value={role.permission} onChange={(p) => p && onChange({ permission: p })} />
        </div>
      </div>

      <label className="block space-y-1">
        <span className="text-[12.5px] text-muted">Prompt mẫu</span>
        <textarea
          rows={9}
          maxLength={8000}
          aria-describedby="role-template-hint"
          className={`${fieldCls} resize-y font-mono text-[12.5px] leading-relaxed`}
          value={role.template}
          onChange={(e) => onChange({ template: e.target.value })}
        />
        <span id="role-template-hint" className="block text-[12px] text-faint">Biến: {'{{task}}'}, {'{{prev}}'}, {'{{Tên bước}}'}</span>
      </label>

      <label className="flex items-center gap-2 text-[13px] text-fg">
        <input type="checkbox" checked={role.gradable} onChange={(e) => onChange({ gradable: e.target.checked })} className="size-4" />
        <span>Chấm đạt/chưa đạt (có nhánh pass/fail trong pipeline)</span>
      </label>

      <button
        type="button"
        onClick={onDelete}
        disabled={!canDelete}
        title={canDelete ? undefined : 'Cần giữ ít nhất một vai trò'}
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] text-danger hover:bg-surface disabled:opacity-50"
      >
        <Trash2 aria-hidden className="size-3.5" />
        Xoá vai trò
      </button>
    </div>
  );
}

function useRolesEditor(open: boolean) {
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    api.roles().then((r) => {
      setRoles(r.roles);
      setSelectedId(r.roles[0]?.id ?? '');
    }, (err: Error) => setError(err.message));
    api.models().then(setCatalog, () => setCatalog(null));
  }, [open]);

  const patch = (change: Partial<RoleDef>) => setRoles((list) => list.map((r) => (r.id === selectedId ? { ...r, ...change } : r)));

  const add = () => {
    const role = blankRole(roles.map((r) => r.id));
    setRoles((list) => [...list, role]);
    setSelectedId(role.id);
  };

  const remove = () => {
    const rest = roles.filter((r) => r.id !== selectedId);
    setRoles(rest);
    setSelectedId(rest[0]?.id ?? '');
  };

  /** Runs a save/reset call, shows its error, and reports whether it worked. */
  const run = async (call: () => Promise<{ roles: RoleDef[] }>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const saved = await call();
      setRoles(saved.roles);
      setSelectedId((id) => (saved.roles.some((r) => r.id === id) ? id : saved.roles[0]?.id ?? ''));
      notifySettingsChanged();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { roles, catalog, selectedId, setSelectedId, error, busy, patch, add, remove, run };
}

/** Roles editor body with its own action bar; `onClose` (modal use) adds a Đóng button and closes after saving. */
export function RolesPanel({ active = true, onClose }: Readonly<{ active?: boolean; onClose?: () => void }>) {
  const ed = useRolesEditor(active);
  const current = ed.roles.find((r) => r.id === ed.selectedId);

  const save = async () => {
    if (await ed.run(() => api.saveRoles(ed.roles)) && onClose) onClose();
  };

  return (
    <>
      <div className="flex flex-col sm:flex-row">
        <RoleList roles={ed.roles} selectedId={ed.selectedId} onSelect={ed.setSelectedId} onAdd={ed.add} />
        {current ? (
          <RoleForm key={current.id} role={current} catalog={ed.catalog} canDelete={ed.roles.length > 1} onChange={ed.patch} onDelete={ed.remove} />
        ) : (
          <p className="p-4 text-[13px] text-faint">Chưa có vai trò nào. Nhấn Mặc định để khôi phục.</p>
        )}
      </div>
      <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-line bg-bg px-5 py-3">
        {ed.error && <p role="alert" className="mr-auto min-w-0 text-[12.5px] text-danger">{ed.error}</p>}
        <button type="button" className={btnCls} disabled={ed.busy} onClick={() => void ed.run(api.resetRoles)}>Mặc định</button>
        {onClose && <button type="button" className={btnCls} onClick={onClose}>Đóng</button>}
        <button type="button" className={primaryBtnCls} disabled={ed.busy || ed.roles.length === 0} onClick={() => void save()}>Lưu</button>
      </div>
    </>
  );
}

/** "Vai trò & model": edit the role list stored on the server. */
export function RolesModal({ open, onClose }: Readonly<{ open: boolean; onClose: () => void }>) {
  return (
    <Modal open={open} onClose={onClose} title="Vai trò & model" width="max-w-4xl">
      <RolesPanel active={open} onClose={onClose} />
    </Modal>
  );
}

export default RolesModal;
