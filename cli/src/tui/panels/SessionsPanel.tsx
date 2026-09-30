import { useState } from 'react';
import path from 'node:path';
import { Text } from 'ink';
import type { RunStatus } from '../../../../server/src/types.ts';
import type { RunSummary } from '../../../../server/src/store.ts';
import { relativeTime } from '../format.ts';
import type { PanelProps } from '../panel-types.ts';
import { getService } from '../service.ts';
import { errText, paint, useLoader } from '../util.ts';
import Confirm from '../widgets/Confirm.tsx';
import Panel from '../widgets/Panel.tsx';
import SelectList from '../widgets/SelectList.tsx';

const STATUS_MARK: Record<RunStatus, string> = { running: '●', done: '✓', error: '✗', cancelled: '■' };
const STATUS_COLOR: Record<RunStatus, string> = { running: 'yellow', done: 'green', error: 'red', cancelled: 'gray' };
const MODE_LABEL: Record<string, string> = { code: 'Code', plan: 'Plan', pipeline: 'Pipeline', debate: 'Debate', pair: 'Pair' };

const sameFolder = (a: string, b: string): boolean => {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
};

/** Title (or the first line of the prompt) on one line. */
export function runTitle(run: RunSummary): string {
  const text = run.title?.trim() || run.prompt.split('\n')[0].trim();
  return text || '(không có tiêu đề)';
}

export function runDescription(run: RunSummary, now = Date.now()): string {
  return [MODE_LABEL[run.mode] ?? run.mode, run.agent, path.basename(run.cwd) || run.cwd, relativeTime(run.createdAt, now)].join(' · ');
}

const HINTS = [['↑↓', 'chọn'], ['gõ', 'lọc'], ['Enter', 'tiếp tục phiên'], ['Tab', 'thư mục này / tất cả'], ['Ctrl+D', 'xoá'], ['Esc', 'đóng']] as const;

/** /sessions: recent runs (this folder or all), filter by typing, Enter continues one, Ctrl+D deletes one. */
export default function SessionsPanel({ cwd, onClose, onPickSession }: Readonly<PanelProps>) {
  const loaded = useLoader(() => getService().list());
  const [all, setAll] = useState(false);
  const [deleting, setDeleting] = useState<RunSummary | undefined>();
  const [error, setError] = useState<string | undefined>();
  const runs = (loaded.data ?? []).filter((run) => all || sameFolder(run.cwd, cwd));

  const remove = async (run: RunSummary) => {
    setDeleting(undefined);
    try {
      await getService().delete(run.id);
      setError(undefined);
      loaded.reload();
    } catch (err) {
      setError(errText(err));
    }
  };

  const scope = all ? 'Tất cả thư mục' : `Thư mục: ${path.basename(cwd) || cwd}`;
  const empty = all ? 'Chưa có phiên nào.' : 'Chưa có phiên nào trong thư mục này. Nhấn Tab để xem tất cả.';
  return (
    <Panel title="Phiên gần đây" subtitle={scope} hints={HINTS} error={error ?? loaded.error}>
      {deleting ? (
        <Confirm message={`Xoá phiên "${runTitle(deleting)}"?`} onYes={() => void remove(deleting)} onNo={() => setDeleting(undefined)} />
      ) : (
        <SelectList
          items={runs}
          getKey={(run) => run.id}
          getLabel={(run) => `${STATUS_MARK[run.status]} ${runTitle(run)}`}
          getDescription={(run) => runDescription(run)}
          getColor={(run) => paint(STATUS_COLOR[run.status])}
          filterable
          filterText={(run) => `${runTitle(run)} ${run.prompt} ${run.mode} ${run.agent} ${path.basename(run.cwd)}`}
          onSelect={(run) => {
            onPickSession?.(run.id);
            onClose();
          }}
          onCancel={onClose}
          onKey={(input, key, run) => {
            if (key.tab) setAll((v) => !v);
            else if (key.ctrl && input === 'd' && run) setDeleting(run);
          }}
          emptyText={loaded.loading ? 'Đang tải…' : empty}
          labelWidth={30}
          maxHeight={10}
        />
      )}
      {loaded.loading && loaded.data ? <Text dimColor>Đang làm mới…</Text> : null}
    </Panel>
  );
}
