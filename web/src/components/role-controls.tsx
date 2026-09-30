import type { AgentName, Permission } from '../api.ts';
import { AgentDot, AGENT_LABEL } from './ui.tsx';

export const PERMISSION_LABEL: Record<Permission, string> = { read: 'Chỉ đọc', edit: 'Sửa file' };

const seg = 'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium transition-colors';
const segOn = 'bg-fg text-bg';
const segOff = 'text-muted hover:bg-surface hover:text-fg';

interface AgentToggleProps {
  value: AgentName | '';
  onChange: (agent: AgentName | '') => void;
  /** Adds a "Tự động" option that leaves the choice to the router. */
  allowAuto?: boolean;
  label?: string;
}

/** Segmented Claude / Codex switch (optionally with Auto). */
export function AgentToggle({ value, onChange, allowAuto = false, label = 'Agent' }: Readonly<AgentToggleProps>) {
  const options: (AgentName | '')[] = allowAuto ? ['', 'claude', 'codex'] : ['claude', 'codex'];
  return (
    <fieldset className="m-0 inline-flex min-w-0 items-center gap-0.5 rounded-lg border border-line p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <label key={o || 'auto'} className={`${seg} cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus ${value === o ? segOn : segOff}`}>
          <input type="radio" name={`agent-${label}`} className="sr-only" checked={value === o} onChange={() => onChange(o)} />
          {o && <AgentDot agent={o} />}
          {o ? AGENT_LABEL[o] : 'Tự động'}
        </label>
      ))}
    </fieldset>
  );
}

interface PermissionSelectProps {
  value: Permission | '';
  onChange: (permission: Permission | '') => void;
  /** Label of the empty option; omit to require a choice. */
  emptyLabel?: string;
  id: string;
  className?: string;
}

/** Native select for read-only / edit permission. */
export function PermissionSelect({ value, onChange, emptyLabel, id, className = '' }: Readonly<PermissionSelectProps>) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value === 'read' || e.target.value === 'edit' ? e.target.value : '')}
      className={`h-7 rounded-lg border border-line bg-bg px-1.5 text-[12.5px] font-medium text-muted hover:border-line-strong hover:text-fg focus:border-focus focus:outline-none ${className}`}
    >
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      <option value="read">{PERMISSION_LABEL.read}</option>
      <option value="edit">{PERMISSION_LABEL.edit}</option>
    </select>
  );
}
