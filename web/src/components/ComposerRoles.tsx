import { Workflow } from 'lucide-react';
import type { PipelineDef, RoleDef } from '../api.ts';
import { chipCls, MenuItem, MenuLabel, Popover } from './ui.tsx';

interface RoleChipsProps {
  roles: RoleDef[];
  roleId: string;
  onPick: (role: RoleDef) => void;
  onEdit: () => void;
}

/** Row above the input: one chip per role, plus a link to the role editor. */
export function RoleChips({ roles, roleId, onPick, onEdit }: Readonly<RoleChipsProps>) {
  if (roles.length === 0) return null;
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 px-3 pt-2.5 pb-0">
      <legend className="sr-only">Vai trò</legend>
      {roles.map((r) => {
        const on = r.id === roleId;
        return (
          <button
            key={r.id}
            type="button"
            aria-pressed={on}
            title={r.description || r.name}
            onClick={() => onPick(r)}
            className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] font-medium transition-colors ${
              on ? 'border-fg bg-fg text-bg' : 'border-line text-muted hover:border-line-strong hover:text-fg'
            }`}
          >
            <span aria-hidden>{r.icon}</span>
            {r.name}
          </button>
        );
      })}
      <button type="button" onClick={onEdit} className="h-7 rounded-lg px-2 text-[12.5px] text-faint underline-offset-2 hover:text-fg hover:underline">
        Sửa vai trò…
      </button>
    </fieldset>
  );
}

interface PipelinePickerProps {
  pipelines: PipelineDef[];
  /** The pipeline chosen while the form is in pipeline mode; '' when not running one. */
  activeId: string;
  side: 'top' | 'bottom';
  onPick: (id: string) => void;
  onEdit: () => void;
}

/** "Pipeline" button: choose a pipeline to run instead of a single turn. */
export function PipelinePicker({ pipelines, activeId, side, onPick, onEdit }: Readonly<PipelinePickerProps>) {
  const active = pipelines.find((p) => p.id === activeId);
  return (
    <Popover
      side={side}
      width="w-64"
      title="Chạy một pipeline"
      triggerClassName={`${chipCls} ${active ? 'text-fg' : ''}`}
      label={
        <>
          <Workflow aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{active ? active.name : 'Pipeline'}</span>
        </>
      }
    >
      {(close) => (
        <>
          <MenuLabel>Pipeline</MenuLabel>
          {pipelines.length === 0 && <p className="px-2.5 pb-2 text-[12.5px] text-faint">Chưa có pipeline nào.</p>}
          {pipelines.map((p) => (
            <MenuItem
              key={p.id}
              selected={p.id === activeId}
              label={p.name}
              hint={`${p.steps.length} bước`}
              onSelect={() => {
                onPick(p.id === activeId ? '' : p.id);
                close();
              }}
            />
          ))}
          <div className="my-1 border-t border-line" />
          <MenuItem
            label="Sửa pipeline…"
            onSelect={() => {
              onEdit();
              close();
            }}
          />
        </>
      )}
    </Popover>
  );
}
