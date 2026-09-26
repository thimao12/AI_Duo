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
  private listeners = new Set<(e: RunEvent) => void>();
  private sessions = new Map<string, string>();
  private saveTimer?: NodeJS.Timeout;

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
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => saveRun(this.run).catch(console.error), 500);
  }

  get cancelled() {
    return this.abort.signal.aborted;
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
    applyAgentEvent(m.parts, event);
    this.emit({ type: 'message.event', id: m.id, event });
  }

  private endMessage(m: Message, status: Message['status'], verdict?: Verdict) {
    m.status = status;
    m.verdict = verdict;
    m.endedAt = Date.now();
    this.emit({ type: 'message.end', id: m.id, status, verdict, endedAt: m.endedAt });
    this.scheduleSave();
  }

  /** One call to one agent, streamed into one message. */
  async turn(t: TurnOptions): Promise<TurnResult> {
    if (this.cancelled) throw new AbortedError();
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
      const msg = err instanceof AbortedError ? 'Cancelled' : (err as Error).message;
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
    this.update({ status, error, endedAt: Date.now() });
    clearTimeout(this.saveTimer);
    await saveRun(this.run);
  }
}

/** Runs currently in progress, keyed by id. */
export const active = new Map<string, RunContext>();
