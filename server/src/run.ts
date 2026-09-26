import { randomUUID } from 'node:crypto';
import { agents, type AgentName, type Role } from './agents/index.ts';
import { AbortedError } from './agents/process.ts';
import { saveRun } from './store.ts';
import { applyAgentEvent, type Message, type Run, type RunConfig, type RunEvent, type Speaker, type Verdict } from './types.ts';

export interface TurnOptions {
  agent: AgentName;
  role: Role;
  prompt: string;
  phase: string;
  round: number;
  title: string;
  /** Turns sharing a key continue the same CLI conversation. Omit for a fresh session. */
  sessionKey?: string;
  parseVerdict?: (text: string) => Verdict | undefined;
}

export interface TurnResult {
  text: string;
  verdict?: Verdict;
}

export class RunContext {
  readonly run: Run;
  readonly abort = new AbortController();
  userCancelled = false;
  private finished = false;
  private listeners = new Set<(e: RunEvent) => void>();
  private inflightTurns = new Set<Promise<unknown>>();
  private sessions = new Map<string, string>();
  private saveTimer?: NodeJS.Timeout;
  private saveInFlight?: Promise<void>;

  constructor(config: RunConfig) {
    this.run = {
      id: `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${randomUUID().slice(0, 6)}`,
      config,
      status: 'running',
      createdAt: Date.now(),
      messages: [],
    };
  }

  subscribe(fn: (e: RunEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: RunEvent) {
    for (const fn of this.listeners) fn(e);
  }

  private scheduleSave() {
    if (this.finished) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      if (this.finished) return;
      this.saveInFlight = (this.saveInFlight ?? Promise.resolve())
        .then(() => saveRun(this.run))
        .catch((err) => console.error(err));
    }, 500);
  }

  get cancelled() {
    return this.userCancelled;
  }

  get inflight(): ReadonlySet<Promise<unknown>> {
    return this.inflightTurns;
  }

  /** A short informational message from the orchestrator itself. */
  note(title: string, text: string, phase = 'info', round = 0) {
    const m = this.startMessage('system', phase, round, title);
    this.pushEvent(m, { kind: 'text', content: text });
    this.endMessage(m, 'done');
  }

  private startMessage(agent: Speaker, phase: string, round: number, title: string): Message {
    const message: Message = { id: randomUUID(), agent, phase, round, title, parts: [], status: 'running', startedAt: Date.now() };
    this.run.messages.push(message);
    this.emit({ type: 'message.start', message: structuredClone(message) });
    return message;
  }

  private pushEvent(m: Message, event: Parameters<typeof applyAgentEvent>[1]) {
    if (this.finished) return;
    applyAgentEvent(m.parts, event);
    this.emit({ type: 'message.event', id: m.id, event });
  }

  private endMessage(m: Message, status: Message['status'], verdict?: Verdict) {
    if (this.finished) return;
    m.status = status;
    m.verdict = verdict;
    m.endedAt = Date.now();
    this.emit({ type: 'message.end', id: m.id, status, verdict, endedAt: m.endedAt });
    this.scheduleSave();
  }

  /** One call to one agent, streamed into one message. */
  turn(t: TurnOptions): Promise<TurnResult> {
    const promise = this.runTurn(t);
    this.inflightTurns.add(promise);
    void promise.then(
      () => this.inflightTurns.delete(promise),
      () => this.inflightTurns.delete(promise),
    );
    return promise;
  }

  private async runTurn(t: TurnOptions): Promise<TurnResult> {
    if (this.abort.signal.aborted) throw new AbortedError();
    const m = this.startMessage(t.agent, t.phase, t.round, t.title);
    const key = t.sessionKey ? `${t.agent}:${t.sessionKey}` : undefined;
    try {
      const res = await agents[t.agent].run({
        prompt: t.prompt,
        cwd: this.run.config.cwd,
        role: t.role,
        sessionId: key ? this.sessions.get(key) : undefined,
        model: this.run.config.models?.[t.agent] || undefined,
        signal: this.abort.signal,
        timeoutMs: (this.run.config.turnTimeoutMin || 30) * 60_000,
        onEvent: (e) => this.pushEvent(m, e),
      });
      if (key && res.sessionId) this.sessions.set(key, res.sessionId);
      // Codex delivers whole messages; if nothing streamed, make sure the final text is shown.
      if (!m.parts.some((p) => p.kind === 'text') && res.finalText) this.pushEvent(m, { kind: 'text', content: res.finalText });
      const verdict = t.parseVerdict?.(res.finalText);
      this.endMessage(m, 'done', verdict);
      return { text: res.finalText, verdict };
    } catch (err) {
      // An internal abort means another turn failed. Leave this message running so
      // finish() can mark it as stopped without reporting a user cancellation.
      if (err instanceof AbortedError && !this.userCancelled) throw err;
      const msg = this.userCancelled && err instanceof AbortedError ? 'Cancelled' : (err as Error).message;
      this.pushEvent(m, { kind: 'error', content: msg });
      this.endMessage(m, 'error');
      throw err;
    }
  }

  update(patch: Extract<RunEvent, { type: 'run.update' }>['patch']) {
    Object.assign(this.run, patch);
    this.emit({ type: 'run.update', patch });
    this.scheduleSave();
  }

  async finish(status: Run['status'], error?: string) {
    if (this.finished) return;
    for (const message of this.run.messages) {
      if (message.status !== 'running') continue;
      this.pushEvent(message, { kind: 'error', content: 'Stopped: run ended' });
      this.endMessage(message, 'error');
    }
    this.update({ status, error, endedAt: Date.now() });
    this.finished = true;
    clearTimeout(this.saveTimer);
    await this.saveInFlight;
    await saveRun(this.run);
  }
}

/** Runs currently in progress, keyed by id. */
export const active = new Map<string, RunContext>();
