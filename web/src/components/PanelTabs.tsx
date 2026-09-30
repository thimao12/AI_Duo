export type PanelTab = 'changes' | 'explorer';

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'changes', label: 'Thay đổi' },
  { id: 'explorer', label: 'Explorer' },
];

/** Switch between the right-hand panels; a disabled tab has nothing to show for this run. */
export default function PanelTabs({ active, changesAvailable, onSelect }: Readonly<{ active: PanelTab; changesAvailable: boolean; onSelect: (tab: PanelTab) => void }>) {
  return (
    <nav aria-label="Bảng bên phải" className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          aria-pressed={active === tab.id}
          disabled={tab.id === 'changes' && !changesAvailable}
          onClick={() => onSelect(tab.id)}
          className={`h-7 rounded-md px-2.5 text-[12.5px] font-medium transition-colors disabled:opacity-40 ${active === tab.id ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface hover:text-fg'}`}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
