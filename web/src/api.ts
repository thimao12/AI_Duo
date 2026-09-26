import { useEffect, useState } from 'react';
import type { AgentName } from '../../server/src/agents/types.ts';
import { applyAgentEvent, type Run, type RunConfig, type RunEvent, type RoutePlan } from '../../server/src/types.ts';

export type { Message, ModelChoice, Part, RoutePlan, Run, RunConfig, Verdict, Speaker } from '../../server/src/types.ts';
export type { AgentName, Usage } from '../../server/src/agents/types.ts';

/** What the form sends: a concrete mode, or 'auto' to let the router decide. */
export type NewRunRequest = Omit<Partial<RunConfig>, 'mode'> & { mode: RunConfig['mode'] | 'auto' };

export interface RoutePreview {
  mode: RunConfig['mode'];
  coder: AgentName;
  judge: AgentName;
  maxRounds: number;
  route: RoutePlan;
  /** The rules aren't sure; starting the run will ask Haiku first. */
  askHaiku: boolean;
}

export interface RunSummary {
  id: string;
  mode: 'debate' | 'pair';
  prompt: string;
  status: Run['status'];
  createdAt: number;
}

export interface AgentStatus {
  claude: string | null;
  codex: string | null;
  claudePath: string | null;
  codexPath: string | null;
  claudeError: string | null;
  codexError: string | null;
  defaultCwd: string;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

export const api = {
  agents: () => fetch('/api/agents').then((r) => json<AgentStatus>(r)),
  list: () => fetch('/api/runs').then((r) => json<RunSummary[]>(r)),
  create: (cfg: NewRunRequest) =>
    fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) }).then((r) =>
      json<{ id: string }>(r),
    ),
  previewRoute: (prompt: string, signal?: AbortSignal) =>
    fetch('/api/route/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }), signal }).then((r) =>
      json<RoutePreview>(r),
    ),
  cancel: (id: string) =>
    fetch(`/api/runs/${id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) =>
      json(r),
    ),
};

function reduce(run: Run | null, e: RunEvent): Run | null {
  if (e.type === 'snapshot') return e.run;
  if (!run) return run;
  const next: Run = { ...run, messages: run.messages };
  switch (e.type) {
    case 'message.start':
      next.messages = [...run.messages, e.message];
      break;
    case 'message.event':
      next.messages = run.messages.map((m) => {
        if (m.id !== e.id) return m;
        const parts = m.parts.map((p) => ({ ...p }));
        applyAgentEvent(parts, e.event);
        return { ...m, parts };
      });
      break;
    case 'message.end':
      next.messages = run.messages.map((m) => (m.id === e.id ? { ...m, status: e.status, verdict: e.verdict, usage: e.usage, endedAt: e.endedAt } : m));
      break;
    case 'run.update':
      Object.assign(next, e.patch);
      break;
  }
  return next;
}

/** Live view of a run: snapshot + streamed events over SSE. */
export function useRun(id: string) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRun(null);
    setError(null);
    const es = new EventSource(`/api/runs/${id}/events`);
    let gotSnapshot = false;
    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data) as RunEvent;
      if (e.type === 'snapshot') gotSnapshot = true;
      setRun((r) => reduce(r, e));
    };
    es.onerror = () => {
      // Server closes the stream once the run is finished; that's not an error.
      es.close();
      if (!gotSnapshot) setError('Run not found or server unreachable.');
    };
    return () => es.close();
  }, [id]);

  return { run, error };
}
