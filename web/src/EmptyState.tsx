import { useCallback, useState } from 'react';
import { PanelLeft } from 'lucide-react';
import type { AgentStatus } from './api.ts';
import Composer, { MODE_ICON, type ComposerSeed } from './components/Composer.tsx';
import { MODE_LABEL } from './components/ui.tsx';

const STARTERS: { mode: ComposerSeed['mode']; prompt: string }[] = [
  { mode: 'debate', prompt: 'So sánh hai cách cache kết quả API tìm kiếm (Redis hay cache trong bộ nhớ) cho project này và chốt một cách.' },
  { mode: 'pair', prompt: 'Tìm và sửa bug trong luồng upload file, viết test tái hiện lỗi trước khi sửa.' },
  { mode: 'auto', prompt: 'Review code trong thư mục này, chỉ ra bug và rủi ro bảo mật theo mức độ nghiêm trọng.' },
];

function CliStatus({ agents }: { agents: AgentStatus | null }) {
  if (!agents) return null;
  const items = [
    { name: 'Claude', version: agents.claude, error: agents.claudeError, path: agents.claudePath },
    { name: 'Codex', version: agents.codex, error: agents.codexError, path: agents.codexPath },
  ];
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[12px] text-faint">
      {items.map((a) => (
        <span key={a.name} title={a.path ?? undefined} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={`size-1.5 rounded-full ${a.version ? 'bg-ok' : 'bg-danger'}`} />
          <span className={a.version ? '' : 'text-danger'}>
            {a.name} {a.version?.replace(/\s*\(.*\)$/, '').replace(/^codex-cli\s*/, '') ?? a.error ?? 'không tìm thấy trong PATH'}
          </span>
        </span>
      ))}
    </p>
  );
}

export default function EmptyState({ projects, onCreated, onMenu, sidebarHidden }: { projects: string[]; onCreated: (id: string) => void; onMenu: () => void; sidebarHidden: boolean }) {
  const [seed, setSeed] = useState<ComposerSeed>();
  const [agents, setAgents] = useState<AgentStatus | null>(null);
  const onAgents = useCallback((a: AgentStatus | null) => setAgents(a), []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="app-drag flex h-12 shrink-0 items-center px-3 sm:px-4">
        <button type="button" onClick={onMenu} title="Hiện danh sách phiên (Ctrl B)" className={`grid size-8 place-items-center rounded-lg text-muted hover:bg-surface hover:text-fg ${sidebarHidden ? '' : 'md:hidden'}`}>
          <PanelLeft aria-hidden className="size-4" />
          <span className="sr-only">Hiện danh sách phiên</span>
        </button>
      </header>
      <div className="flex min-h-0 flex-1 overflow-y-auto">
        <div className="m-auto w-full max-w-[720px] px-5 py-10">
          <h1 className="text-center text-[26px] font-semibold tracking-[-0.02em] text-balance">Giao việc cho Claude và Codex</h1>
          <p className="mt-2 mb-8 text-center text-[14px] text-muted">Hai agent kiểm tra chéo nhau. Bạn xem kết quả và diff rồi tự commit.</p>

          <Composer variant="hero" projects={projects} onCreated={onCreated} seed={seed} onAgents={onAgents} />

          <ul className="mt-6 space-y-0.5">
            {STARTERS.map((s, i) => {
              const Icon = MODE_ICON[s.mode];
              return (
                <li key={s.mode}>
                  <button
                    type="button"
                    onClick={() => setSeed({ ...s, n: i + Date.now() })}
                    className="flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left text-[13px] text-muted transition-colors hover:bg-surface hover:text-fg"
                  >
                    <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-faint" />
                    <span className="min-w-0">
                      <span className="font-medium text-fg">{MODE_LABEL[s.mode]}</span>
                      <span className="text-faint"> · </span>
                      {s.prompt}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="mt-10">
            <CliStatus agents={agents} />
          </div>
        </div>
      </div>
    </div>
  );
}
