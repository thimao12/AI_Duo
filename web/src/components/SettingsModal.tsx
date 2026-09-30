import { useState, type ReactNode } from 'react';
import { useCliSettings } from '../cli-settings.ts';
import type { ThemePref } from '../theme.ts';
import CliSettingsPanel from './CliSettingsPanel.tsx';
import Modal from './Modal.tsx';
import { PipelinesPanel } from './PipelinesModal.tsx';
import { RolesPanel } from './RolesModal.tsx';
import UsagePanel from './UsagePanel.tsx';

type TabId = 'cli' | 'roles' | 'pipelines' | 'usage' | 'theme';

const TABS: { id: TabId; label: string }[] = [
  { id: 'cli', label: 'CLI' },
  { id: 'roles', label: 'Vai trò & model' },
  { id: 'pipelines', label: 'Pipelines' },
  { id: 'usage', label: 'Usage & kết nối' },
  { id: 'theme', label: 'Giao diện' },
];

const THEMES: { id: ThemePref; label: string }[] = [
  { id: 'light', label: 'Sáng' },
  { id: 'dark', label: 'Tối' },
  { id: 'system', label: 'Theo hệ thống' },
];

const UNSAVED = 'Bạn có thay đổi CLI chưa lưu. Đóng và bỏ các thay đổi này?';

function ThemePanel({ pref, onChange }: Readonly<{ pref: ThemePref; onChange: (pref: ThemePref) => void }>) {
  return (
    <div className="p-4">
      <fieldset className="space-y-2">
        <legend className="mb-2 text-[13.5px] font-semibold text-fg">Giao diện</legend>
        {THEMES.map((t) => (
          <label key={t.id} className="flex items-center gap-2 text-[13px] text-fg">
            <input type="radio" name="theme" checked={pref === t.id} onChange={() => onChange(t.id)} className="size-4" />
            <span>{t.label}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}

function TabList({ tab, onSelect }: Readonly<{ tab: TabId; onSelect: (id: TabId) => void }>) {
  return (
    <nav aria-label="Mục cài đặt" className="flex w-full shrink-0 gap-0.5 overflow-x-auto border-b border-line p-2 sm:w-48 sm:flex-col sm:border-r sm:border-b-0">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-current={t.id === tab ? 'page' : undefined}
          onClick={() => onSelect(t.id)}
          className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-surface ${t.id === tab ? 'bg-surface font-medium text-fg' : 'text-muted'}`}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  theme: { pref: ThemePref; setPref: (pref: ThemePref) => void };
}

/** One place for every setting: CLI configuration, roles, pipelines, usage and appearance. */
export default function SettingsModal({ open, onClose, theme }: Readonly<SettingsModalProps>) {
  const [tab, setTab] = useState<TabId>('cli');
  const cli = useCliSettings(open);

  const requestClose = () => {
    if (cli.dirty && !window.confirm(UNSAVED)) return;
    onClose();
  };

  const panels: Record<TabId, ReactNode> = {
    cli: (
      <CliSettingsPanel
        draft={cli.draft}
        baseline={cli.baseline}
        result={cli.result}
        dirty={cli.dirty}
        error={cli.error}
        busy={cli.busy}
        revision={cli.revision}
        onSave={() => void cli.save()}
        onCli={cli.patchCli}
        onGlobal={cli.patchGlobal}
      />
    ),
    roles: <RolesPanel />,
    pipelines: <PipelinesPanel />,
    usage: <UsagePanel />,
    theme: <ThemePanel pref={theme.pref} onChange={theme.setPref} />,
  };

  return (
    <Modal open={open} onClose={requestClose} title="Cài đặt" width="max-w-5xl">
      <div className="flex flex-col sm:min-h-[60vh] sm:flex-row">
        <TabList tab={tab} onSelect={setTab} />
        <div className="min-w-0 flex-1">{panels[tab]}</div>
      </div>
    </Modal>
  );
}
