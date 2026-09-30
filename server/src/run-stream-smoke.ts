import assert from 'node:assert/strict';
import { coalesceTextDeltas, reconnectDelay, reduceRunEvents, startRunStream, type RunEventSource, type RunStreamRuntime } from '../../web/src/run-events.ts';
import type { Run, RunEvent } from './types.ts';

const run: Run = {
  id: 'stream-smoke',
  config: { mode: 'debate', prompt: 'test', cwd: '.', maxRounds: 1, judge: 'claude', coder: 'codex', turnTimeoutMin: 1 },
  status: 'running',
  createdAt: 1,
  messages: [
    {
      id: 'message-1',
      agent: 'claude',
      phase: 'propose',
      round: 1,
      title: 'proposal',
      parts: [{ kind: 'text', content: 'start' }],
      status: 'running',
      startedAt: 1,
    },
  ],
};

let partCopies = 0;
const originalParts = run.messages[0]!.parts;
const originalMap = originalParts.map;
originalParts.map = function <T>(this: typeof originalParts, callback: (part: (typeof originalParts)[number], index: number, parts: typeof originalParts) => T, thisArg?: unknown): T[] {
  partCopies++;
  return originalMap.call(this, callback, thisArg) as T[];
};

const events: RunEvent[] = [
  { type: 'message.event', id: 'message-1', event: { kind: 'text_delta', content: ' ' } },
  { type: 'message.event', id: 'message-1', event: { kind: 'text_delta', content: 'streamed' } },
  { type: 'message.event', id: 'message-1', event: { kind: 'text_delta', content: ' output' } },
  { type: 'message.event', id: 'message-1', event: { kind: 'tool', content: 'Shell: echo ok' } },
  { type: 'message.event', id: 'message-1', event: { kind: 'text_delta', content: ' done' } },
  { type: 'run.update', patch: { final: 'complete', status: 'done' } },
];

const coalesced = coalesceTextDeltas(events);
assert.equal(coalesced.length, 4, 'adjacent text deltas should become one event, separated runs should remain separate');
assert.deepEqual(coalesced[0], { type: 'message.event', id: 'message-1', event: { kind: 'text_delta', content: ' streamed output' } });

const updated = reduceRunEvents(run, events)!;
assert.equal(partCopies, 1, 'parts should be copied once per message in a frame');
assert.equal(run.messages[0]!.parts[0]!.content, 'start', 'reducing events must not mutate the snapshot');
assert.deepEqual(updated.messages[0]!.parts, [
  { kind: 'text', content: 'start streamed output' },
  { kind: 'tool', content: 'Shell: echo ok' },
  { kind: 'text', content: ' done' },
]);
assert.equal(updated.status, 'done');
assert.equal(updated.final, 'complete');

assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(reconnectDelay), [1000, 2000, 5000, 10000, 20000, 30000, 30000]);

class FakeEventSource implements RunEventSource {
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  closed = false;

  close() {
    this.closed = true;
  }

  send(event: RunEvent) {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }

  fail() {
    this.onerror?.({} as Event);
  }
}

class FakeRuntime implements RunStreamRuntime {
  sources: FakeEventSource[] = [];
  frames = new Map<number, FrameRequestCallback>();
  timers: { id: number; delay: number; callback: () => void; cancelled: boolean }[] = [];
  visibilityListeners = new Set<() => void>();
  hidden = false;
  #nextId = 1;

  open() {
    const source = new FakeEventSource();
    this.sources.push(source);
    return source;
  }

  requestFrame(callback: FrameRequestCallback) {
    const id = this.#nextId++;
    this.frames.set(id, callback);
    return id;
  }

  cancelFrame(id: number) {
    this.frames.delete(id);
  }

  setTimeout(callback: () => void, delay: number) {
    const id = this.#nextId++;
    this.timers.push({ id, delay, callback, cancelled: false });
    return id;
  }

  clearTimeout(id: number) {
    const timer = this.timers.find((item) => item.id === id);
    if (timer) timer.cancelled = true;
  }

  isHidden() {
    return this.hidden;
  }

  addVisibilityListener(callback: () => void) {
    this.visibilityListeners.add(callback);
  }

  removeVisibilityListener(callback: () => void) {
    this.visibilityListeners.delete(callback);
  }

  setHidden(hidden: boolean) {
    this.hidden = hidden;
    for (const listener of this.visibilityListeners) listener();
  }

  flushFrame() {
    const next = this.frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!next) throw new Error('No animation frame was scheduled');
    this.frames.delete(next[0]);
    next[1](0);
  }

  flushTimer(delay: number) {
    const timer = this.timers.find((item) => !item.cancelled && item.delay === delay);
    if (!timer) throw new Error(`No active ${delay}ms timer was scheduled`);
    timer.cancelled = true;
    timer.callback();
  }

  activeTimers() {
    return this.timers.filter((timer) => !timer.cancelled);
  }
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function verifyReconnectStateMachine() {
  const runtime = new FakeRuntime();
  const states: Run[] = [];
  const banner: boolean[] = [];
  const errors: (string | null)[] = [];
  const stop = startRunStream(
    run.id,
    {
      isRunMissing: () => Promise.reject(new Error('server unavailable')),
      onRun: (next) => {
        if (next) states.push(next);
      },
      onReconnecting: (value) => banner.push(value),
      onError: (value) => errors.push(value),
    },
    runtime,
  );

  runtime.sources[0]!.fail();
  await flushMicrotasks();
  assert.deepEqual(runtime.activeTimers().map((timer) => timer.delay), [1000], 'unavailable server should retry after one second');
  assert.equal(banner.at(-1), true, 'connection loss should show the reconnect banner');

  runtime.flushTimer(1000);
  const reconnected = runtime.sources[1]!;
  reconnected.send({ type: 'snapshot', run });
  assert.equal(banner.at(-1), false, 'a fresh snapshot should clear the reconnect banner');
  assert.equal(runtime.frames.size, 1, 'multiple events before a frame should schedule a single flush');
  runtime.flushFrame();
  assert.equal(states.at(-1)?.id, run.id);

  reconnected.fail();
  assert.equal(runtime.activeTimers().at(-1)?.delay, 1000, 'an active run should reconnect after a disconnect');
  runtime.flushTimer(1000);
  const restored = { ...run, status: 'error' as const, error: 'Interrupted (server restarted)' };
  runtime.sources[2]!.send({ type: 'snapshot', run: restored });
  runtime.flushFrame();
  assert.equal(states.at(-1)?.status, 'error', 'the reconnect snapshot should replace the running state');
  assert.equal(banner.at(-1), false);

  runtime.sources[2]!.fail();
  assert.equal(runtime.activeTimers().length, 0, 'a terminal snapshot should not reconnect');
  assert.deepEqual(errors, []);
  stop();
}

async function verifyMissingRunStopsRetrying() {
  const runtime = new FakeRuntime();
  const errors: (string | null)[] = [];
  const banner: boolean[] = [];
  const stop = startRunStream(
    'deleted-run',
    {
      isRunMissing: () => Promise.resolve(true),
      onRun: () => {},
      onReconnecting: (value) => banner.push(value),
      onError: (value) => errors.push(value),
    },
    runtime,
  );
  runtime.sources[0]!.fail();
  await flushMicrotasks();
  assert.deepEqual(errors, ['Không tìm thấy phiên này.']);
  assert.equal(banner.at(-1), false);
  assert.equal(runtime.activeTimers().length, 0, 'a missing run should not retry');
  stop();
}

function verifyDoneRunDoesNotRetry() {
  const runtime = new FakeRuntime();
  const banner: boolean[] = [];
  const doneRun = { ...run, status: 'done' as const, final: 'complete' };
  const stop = startRunStream(
    run.id,
    {
      isRunMissing: () => Promise.resolve(false),
      onRun: () => {},
      onReconnecting: (value) => banner.push(value),
      onError: () => {},
    },
    runtime,
  );
  runtime.sources[0]!.send({ type: 'snapshot', run: doneRun });
  runtime.flushFrame();
  runtime.sources[0]!.fail();
  assert.equal(runtime.activeTimers().length, 0, 'a done run should not reconnect when its stream closes');
  assert.equal(banner.at(-1), false);
  stop();
}

function verifyHiddenTabFlush() {
  const runtime = new FakeRuntime();
  let flushes = 0;
  const stop = startRunStream(
    run.id,
    {
      isRunMissing: () => Promise.resolve(false),
      onRun: () => flushes++,
      onReconnecting: () => {},
      onError: () => {},
    },
    runtime,
  );
  runtime.sources[0]!.send({ type: 'snapshot', run });
  runtime.setHidden(true);
  assert.equal(runtime.frames.size, 0, 'hiding the tab should cancel its paused animation frame');
  assert.equal(runtime.activeTimers().at(-1)?.delay, 100, 'hidden tabs should use a timer flush');
  runtime.flushTimer(100);
  assert.equal(flushes, 1);
  stop();
}

await verifyReconnectStateMachine();
await verifyMissingRunStopsRetrying();
verifyDoneRunDoesNotRetry();
verifyHiddenTabFlush();
console.log('SSE coalescing, frame reduction, reconnect state, missing/done runs, hidden-tab flush, and backoff passed.');
