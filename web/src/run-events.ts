import { applyAgentEvent, type Run, type RunEvent } from '../../server/src/types.ts';

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 20000, 30000] as const;

export function reconnectDelay(attempt: number): number {
  return RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)] ?? RECONNECT_DELAYS[0];
}

/** Combine adjacent text chunks for the same message before applying a frame's events. */
export function coalesceTextDeltas(events: readonly RunEvent[]): RunEvent[] {
  const combined: RunEvent[] = [];
  for (const event of events) {
    const previous = combined.at(-1);
    if (
      previous?.type === 'message.event' &&
      event.type === 'message.event' &&
      previous.id === event.id &&
      previous.event.kind === 'text_delta' &&
      event.event.kind === 'text_delta'
    ) {
      combined[combined.length - 1] = {
        ...previous,
        event: { ...previous.event, content: previous.event.content + event.event.content },
      };
    } else {
      combined.push(event);
    }
  }
  return combined;
}

/** Copy-on-write editor over a run's messages: each changed message's parts are copied at most once per frame. */
class RunEditor {
  run: Run | null;
  private messagesCopied = false;
  private messageIndexes: Map<string, number> | undefined;
  private readonly copiedParts = new Set<string>();

  constructor(initial: Run | null) {
    this.run = initial;
  }

  private static indexMessages(source: Run) {
    return new Map(source.messages.map((message, index) => [message.id, index]));
  }

  private resetForSnapshot() {
    this.messagesCopied = false;
    this.messageIndexes = undefined;
    this.copiedParts.clear();
  }

  private ensureMessages() {
    if (!this.run || this.messagesCopied) return;
    this.run = { ...this.run, messages: [...this.run.messages] };
    this.messagesCopied = true;
    this.messageIndexes = RunEditor.indexMessages(this.run);
  }

  private messageIndex(id: string) {
    if (!this.run) return -1;
    this.messageIndexes ??= RunEditor.indexMessages(this.run);
    return this.messageIndexes.get(id) ?? -1;
  }

  apply(event: RunEvent) {
    if (event.type === 'snapshot') {
      this.run = event.run;
      this.resetForSnapshot();
      return;
    }
    if (!this.run) return;

    switch (event.type) {
      case 'message.start':
        this.ensureMessages();
        this.run!.messages.push(event.message);
        this.messageIndexes!.set(event.message.id, this.run!.messages.length - 1);
        break;
      case 'message.event': {
        const index = this.messageIndex(event.id);
        if (index < 0) break;
        this.ensureMessages();
        const messages = this.run!.messages;
        const message = messages[index]!;
        if (!this.copiedParts.has(event.id)) {
          messages[index] = { ...message, parts: message.parts.map((part) => ({ ...part })) };
          this.copiedParts.add(event.id);
        }
        applyAgentEvent(messages[index]!.parts, event.event);
        break;
      }
      case 'message.end': {
        const index = this.messageIndex(event.id);
        if (index < 0) break;
        this.ensureMessages();
        const messages = this.run!.messages;
        messages[index] = {
          ...messages[index]!,
          status: event.status,
          verdict: event.verdict,
          usage: event.usage,
          endedAt: event.endedAt,
        };
        break;
      }
      case 'run.update':
        this.run = { ...this.run, ...event.patch };
        break;
    }
  }
}

/** Apply a frame's events while copying each changed message's parts at most once. */
export function reduceRunEvents(initial: Run | null, events: readonly RunEvent[]): Run | null {
  const editor = new RunEditor(initial);
  for (const event of coalesceTextDeltas(events)) editor.apply(event);
  return editor.run;
}

export interface RunEventSource {
  onmessage: ((event: MessageEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  close(): void;
}

export interface RunStreamRuntime {
  open(url: string): RunEventSource;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(frame: number): void;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(timer: number): void;
  isHidden(): boolean;
  addVisibilityListener(callback: () => void): void;
  removeVisibilityListener(callback: () => void): void;
}

export interface RunStreamCallbacks {
  /** Resolves true only when the run endpoint returned 404; network failures reject. */
  isRunMissing(): Promise<boolean>;
  onRun(run: Run | null): void;
  onReconnecting(reconnecting: boolean): void;
  onError(error: string | null): void;
}

const browserRuntime: RunStreamRuntime = {
  open: (url) => new EventSource(url),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (frame) => cancelAnimationFrame(frame),
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (timer) => window.clearTimeout(timer),
  isHidden: () => document.hidden,
  addVisibilityListener: (callback) => document.addEventListener('visibilitychange', callback),
  removeVisibilityListener: (callback) => document.removeEventListener('visibilitychange', callback),
};

const HIDDEN_FLUSH_MS = 100;

/** Own the SSE connection, retry timer, and per-frame event queue for one run. */
export function startRunStream(
  id: string,
  callbacks: RunStreamCallbacks,
  runtime: RunStreamRuntime = browserRuntime,
): () => void {
  let source: RunEventSource | null = null;
  let reconnectTimer: number | undefined;
  let frame: number | undefined;
  let hiddenFlushTimer: number | undefined;
  let retryAttempt = 0;
  let gotSnapshot = false;
  let observedStatus: Run['status'] | null = null;
  let latestRun: Run | null = null;
  let active = true;
  let stopped = false;
  const queue: RunEvent[] = [];

  const flush = () => {
    frame = undefined;
    hiddenFlushTimer = undefined;
    if (!active || queue.length === 0) return;
    latestRun = reduceRunEvents(latestRun, queue.splice(0));
    callbacks.onRun(latestRun);
  };

  const scheduleFlush = () => {
    if (frame !== undefined || hiddenFlushTimer !== undefined) return;
    if (runtime.isHidden()) hiddenFlushTimer = runtime.setTimeout(flush, HIDDEN_FLUSH_MS);
    else frame = runtime.requestFrame(flush);
  };

  const handleVisibilityChange = () => {
    if (!active || !runtime.isHidden() || frame === undefined) return;
    runtime.cancelFrame(frame);
    frame = undefined;
    scheduleFlush();
  };

  const scheduleReconnect = () => {
    reconnectTimer = runtime.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, reconnectDelay(retryAttempt++));
  };

  const connect = () => {
    if (!active || stopped) return;
    const current = runtime.open(`/api/runs/${id}/events`);
    source = current;
    current.onmessage = (message) => {
      if (!active || stopped || current !== source) return;
      const event = JSON.parse(message.data) as RunEvent;
      if (event.type === 'snapshot') {
        gotSnapshot = true;
        observedStatus = event.run.status;
        retryAttempt = 0;
        callbacks.onReconnecting(false);
      } else if (event.type === 'run.update' && event.patch.status) {
        observedStatus = event.patch.status;
      }
      queue.push(event);
      scheduleFlush();
    };
    current.onerror = () => {
      if (!active || stopped || current !== source) return;
      current.close();
      source = null;
      if (gotSnapshot && observedStatus !== 'running') {
        callbacks.onReconnecting(false);
        return;
      }
      callbacks.onReconnecting(true);
      if (gotSnapshot) {
        scheduleReconnect();
        return;
      }

      void callbacks.isRunMissing().then(
        (missing) => {
          if (!active || stopped) return;
          if (missing) {
            stopped = true;
            callbacks.onReconnecting(false);
            callbacks.onError('Không tìm thấy phiên này.');
          } else {
            scheduleReconnect();
          }
        },
        () => {
          if (active && !stopped) scheduleReconnect();
        },
      );
    };
  };

  runtime.addVisibilityListener(handleVisibilityChange);
  connect();
  return () => {
    active = false;
    source?.close();
    if (reconnectTimer !== undefined) runtime.clearTimeout(reconnectTimer);
    if (frame !== undefined) runtime.cancelFrame(frame);
    if (hiddenFlushTimer !== undefined) runtime.clearTimeout(hiddenFlushTimer);
    runtime.removeVisibilityListener(handleVisibilityChange);
    queue.length = 0;
  };
}
