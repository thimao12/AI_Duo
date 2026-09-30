import { useStdout } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunHandle, RunRequest, RunService, StartOptions } from '../../../server/src/service.ts';
import type { Message, Run, RunEvent } from '../../../server/src/types.ts';
import { reduceRunEvents } from '../../../web/src/run-events.ts';
import { errorText } from './theme.ts';
import { commitFinished, effortFor, liveMessages, type ThreadItem } from './thread.ts';

/** The part of RunService the chat uses; tests supply a fake. */
export type ChatService = Pick<RunService, 'start' | 'continue' | 'get' | 'preflight' | 'previewRoute' | 'abortAll'>;

export type Phase = 'idle' | 'starting' | 'running';

export interface HeaderInfo {
  cwd: string;
  branch?: string;
  version: string;
}

export interface Session {
  /** Printed thread (append-only between clears). */
  log: ThreadItem[];
  /** Messages still streaming. */
  live: Message[];
  run: Run | null;
  handle: RunHandle | null;
  phase: Phase;
  startedAt: number | null;
  /** Changes when the printed thread is reset, so <Static> starts over. */
  epoch: number;
  /** Start a run or continue the session; resolves to an error message, or null once the run is going. */
  send(request: RunRequest, prompt: string): Promise<string | null>;
  /** Stop the run (also one that is still starting). */
  cancel(): void;
  /** Load a saved run and continue it in this window; resolves to an error message or the run. */
  resume(runId: string): Promise<string | Run>;
  clear(): void;
  reset(): void;
  notice(tone: 'info' | 'warn' | 'error', text: string): void;
}

const CLEAR_SCREEN = '\u001B[2J\u001B[3J\u001B[H';
const FLUSH_MS = 60;

const cloneRun = (run: Run): Run => structuredClone(run);

export function useSession(service: ChatService, header: HeaderInfo): Session {
  const { stdout } = useStdout();
  const ids = useRef(0);
  const nextId = (kind: string) => `${kind}-${++ids.current}`;
  const headerItem = (): ThreadItem => ({ id: nextId('header'), kind: 'header', ...header });

  const [log, setLog] = useState<ThreadItem[]>(() => [{ id: 'header-0', kind: 'header', ...header }]);
  const [live, setLive] = useState<Message[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [handle, setHandle] = useState<RunHandle | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [epoch, setEpoch] = useState(0);

  const runRef = useRef<Run | null>(null);
  const committed = useRef(new Set<string>());
  const phaseRef = useRef<Phase>('idle');
  const handleRef = useRef<RunHandle | null>(null);
  const cancelRequested = useRef(false);
  const queue = useRef<RunEvent[]>([]);
  const timer = useRef<NodeJS.Timeout | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const append = useCallback((items: ThreadItem[]) => {
    if (items.length && mounted.current) setLog((l) => [...l, ...items]);
  }, []);

  const changePhase = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  /** Adopt a new run state: print what finished, keep the rest live. */
  const adopt = (next: Run, withUser = false) => {
    runRef.current = next;
    const finished = commitFinished(next.messages, committed.current, withUser);
    append(finished.map((message) => ({ id: `message-${message.id}`, kind: 'message', message, effort: effortFor(next, message) })));
    if (!mounted.current) return;
    setRun(next);
    setLive(liveMessages(next.messages, committed.current));
  };

  const flush = () => {
    timer.current = undefined;
    const events = queue.current.splice(0);
    if (events.length) adopt(reduceRunEvents(runRef.current, events) ?? runRef.current!);
  };

  const onEvent = (event: RunEvent) => {
    queue.current.push(event);
    timer.current ??= setTimeout(flush, FLUSH_MS);
  };

  const finish = (started: RunHandle) => {
    void started.done.then((final) => {
      clearTimeout(timer.current);
      timer.current = undefined;
      queue.current.length = 0;
      const snapshot = cloneRun(final);
      adopt(snapshot);
      append([{ id: nextId('summary'), kind: 'summary', run: snapshot }]);
      cancelRequested.current = false;
      if (!mounted.current) return;
      handleRef.current = null;
      setHandle(null);
      setStartedAt(null);
      changePhase('idle');
    });
  };

  const send = async (request: RunRequest, prompt: string): Promise<string | null> => {
    if (phaseRef.current !== 'idle') return 'A run is already in progress.';
    changePhase('starting');
    cancelRequested.current = false;
    setStartedAt(Date.now());
    const options: StartOptions = {
      onCreated: (created) => {
        append([{ id: nextId('user'), kind: 'user', text: prompt }]);
        adopt(cloneRun(created));
      },
      onEvent,
    };
    try {
      const id = runRef.current?.id;
      const started = id ? await service.continue(id, request, options) : await service.start(request, options);
      if (cancelRequested.current) started.cancel();
      handleRef.current = started;
      setHandle(started);
      changePhase('running');
      // A decision may already be waiting when the handle arrives.
      const { planDecision, pairDecision } = started.run;
      if ((planDecision || pairDecision) && runRef.current) adopt({ ...runRef.current, planDecision, pairDecision });
      finish(started);
      return null;
    } catch (err) {
      setStartedAt(null);
      changePhase('idle');
      return errorText(err);
    }
  };

  const cancel = () => {
    cancelRequested.current = true;
    handleRef.current?.cancel();
  };

  const resetView = (items: ThreadItem[]) => {
    stdout.write(CLEAR_SCREEN);
    setLog(items);
    setEpoch((e) => e + 1);
  };

  const notice = useCallback((tone: 'info' | 'warn' | 'error', text: string) => {
    if (mounted.current) setLog((l) => [...l, { id: `notice-${++ids.current}`, kind: 'notice', tone, text }]);
  }, []);

  const clear = () => resetView([headerItem()]);

  const reset = () => {
    if (phaseRef.current !== 'idle') return;
    committed.current = new Set();
    runRef.current = null;
    setRun(null);
    setLive([]);
    resetView([headerItem()]);
  };

  const resume = async (runId: string): Promise<string | Run> => {
    if (phaseRef.current !== 'idle') return 'Wait for the current run to finish (or press Ctrl+C) before switching sessions.';
    let loaded: Run | undefined;
    try {
      loaded = await service.get(runId);
    } catch (err) {
      return errorText(err);
    }
    if (!loaded) return `Run ${runId} was not found.`;
    if (loaded.status === 'running') return 'That session is still running (in this or another window).';
    const snapshot = cloneRun(loaded);
    committed.current = new Set();
    const messages = commitFinished(snapshot.messages, committed.current, true);
    const items: ThreadItem[] = [
      headerItem(),
      { id: nextId('notice'), kind: 'notice', tone: 'info', text: `Resumed “${snapshot.title || snapshot.config.prompt.split('\n')[0].slice(0, 80)}”. Your next message continues it.` },
      ...messages.map((message): ThreadItem => (message.agent === 'user'
        ? { id: `user-${message.id}`, kind: 'user', text: message.parts[0]?.content ?? '' }
        : { id: `message-${message.id}`, kind: 'message', message, effort: effortFor(snapshot, message) })),
      { id: nextId('summary'), kind: 'summary', run: snapshot },
    ];
    runRef.current = snapshot;
    setRun(snapshot);
    setLive([]);
    resetView(items);
    return snapshot;
  };

  return { log, live, run, handle, phase, startedAt, epoch, send, cancel, resume, clear, reset, notice };
}
