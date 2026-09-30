import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AgentName, type ConnectionStatus } from '../api.ts';
import { AGENT_LABEL, Spinner } from './ui.tsx';

const RECHECK_AFTER_LOGIN_MS = 5000;

const INSTALL_COMMAND: Record<AgentName, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
};

const LOGIN_COMMAND: Record<AgentName, string> = {
  claude: 'claude auth login',
  codex: 'codex login',
};

const SMALL_BUTTON = 'inline-flex h-6 items-center gap-1 rounded-md border border-line px-2 text-[11.5px] text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-60';

/** Human-readable connection state of a CLI. */
export function connectionLabel(status: ConnectionStatus | null): string {
  if (!status) return 'Đang kiểm tra…';
  if (!status.installed) return 'Chưa cài';
  if (status.loggedIn === false) return 'Đã cài, chưa đăng nhập';
  if (status.loggedIn === null) return 'Không xác định';
  const detail = [status.method, status.account].filter(Boolean).join(' · ');
  return detail ? `Đã đăng nhập (${detail})` : 'Đã đăng nhập';
}

/** True when the user still has something to do (install or log in). */
export function needsSetup(status: ConnectionStatus | null): boolean {
  return status !== null && (!status.installed || status.loggedIn === false);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The clipboard API is unavailable or denied; the caller shows a manual-copy hint.
    return false;
  }
}

function CommandLine({ command }: Readonly<{ command: string }>) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = () => { void copyText(command).then(setCopied); };
  return (
    <span className="mt-1 flex items-center gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-surface-2 px-2 py-1 text-[11.5px] text-fg">{command}</code>
      <button type="button" onClick={copy} className={SMALL_BUTTON}>Copy</button>
      <output className="text-[11px] text-faint">
        {copied === true && 'Đã chép'}
        {copied === false && 'Không chép được, hãy chọn và chép thủ công'}
      </output>
    </span>
  );
}

function useConnection(name: AgentName, signal: number) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const check = useCallback(() => {
    api.connection(name).then(
      (value) => { setStatus(value); setCheckError(null); },
      (err: Error) => setCheckError(err.message),
    );
  }, [name]);

  useEffect(() => {
    check();
  }, [check, signal]);

  useEffect(() => {
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [check]);

  return { status, checkError, check };
}

function useLogin(name: AgentName, recheck: () => void) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const open = () => {
    setBusy(true);
    setMessage(null);
    api.openLogin(name).then(
      () => {
        setMessage({ ok: true, text: 'Đã mở cửa sổ terminal. Hoàn tất đăng nhập ở đó, app sẽ tự kiểm tra lại.' });
        clearTimeout(timer.current);
        timer.current = setTimeout(recheck, RECHECK_AFTER_LOGIN_MS);
      },
      (err: Error) => setMessage({ ok: false, text: err.message }),
    ).finally(() => setBusy(false));
  };
  return { busy, message, open };
}

interface GuideProps {
  name: AgentName;
  status: ConnectionStatus | null;
  onOpenCliSettings?: () => void;
  onRecheck: () => void;
}

function SetupGuide({ name, status, onOpenCliSettings, onRecheck }: Readonly<GuideProps>) {
  const login = useLogin(name, onRecheck);
  return (
    <ol className="mt-2 list-decimal space-y-2.5 pl-4 text-[11.5px] text-muted">
      {status?.installed === false && (
        <li>
          Cài CLI:
          <CommandLine command={INSTALL_COMMAND[name]} />
          <span className="mt-1 block text-faint">
            Hoặc đặt &quot;Đường dẫn CLI&quot; trong Cài đặt → CLI.
            {onOpenCliSettings && (
              <>
                {' '}
                <button type="button" onClick={onOpenCliSettings} className="text-info underline underline-offset-2">Mở tab CLI</button>
              </>
            )}
          </span>
        </li>
      )}
      <li>
        Đăng nhập tài khoản:
        <CommandLine command={LOGIN_COMMAND[name]} />
        <span className="mt-1.5 flex items-center gap-2">
          <button type="button" onClick={login.open} disabled={login.busy} className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-fg transition-opacity hover:opacity-90 disabled:opacity-60">
            {login.busy && <Spinner className="size-3" />}
            Mở terminal đăng nhập
          </button>
        </span>
        <output className={`mt-1 block text-[11px] ${login.message?.ok === false ? 'text-danger' : 'text-faint'}`}>{login.message?.text}</output>
      </li>
      <li>Bấm Test / Làm mới để kiểm tra.</li>
      <li className="list-none -ml-4 text-[11px] text-faint">
        Đăng nhập bằng gói thuê bao; biến API key tính phí theo token bị app loại bỏ khi chạy.
      </li>
    </ol>
  );
}

/** Connection status of one CLI plus a numbered install / login guide when it is not ready. */
export default function ConnectionGuide({ name, onOpenCliSettings, recheckSignal = 0 }: Readonly<{ name: AgentName; onOpenCliSettings?: () => void; recheckSignal?: number }>) {
  const { status, checkError, check } = useConnection(name, recheckSignal);
  const setup = needsSetup(status);
  return (
    <div className="mt-2.5 border-t border-line pt-2">
      <div className="flex items-center justify-between gap-2 text-[11.5px]">
        <span className="text-muted">Kết nối {AGENT_LABEL[name]}</span>
        <output className={setup ? 'font-medium text-warn' : 'text-faint'}>{connectionLabel(status)}</output>
      </div>
      {checkError && <p role="alert" className="mt-1 text-[11px] text-danger">{checkError}</p>}
      {setup && <SetupGuide name={name} status={status} onOpenCliSettings={onOpenCliSettings} onRecheck={check} />}
    </div>
  );
}
