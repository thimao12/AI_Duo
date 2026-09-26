import { useEffect, useState } from 'react';
import { applyAgentEvent, type Run, type RunConfig, type RunEvent } from '../../server/src/types.ts';

export type { Message, Part, Run, RunConfig, Verdict, Speaker } from '../../server/src/types.ts';
export type { AgentName } from '../../server/src/agents/types.ts';

export interface RunSummary {
  id: string;
  mode: 'debate' | 'pair';
  prompt: string;
  status: Run['status'];
  createdAt: number;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

export const api = {
  agents: () => fetch('/api/agents').then((r) => json<{ claude: string | null; codex: string | null; defaultCwd: string }>(r)),
  list: () => fetch('/api/runs').then((r) => json<RunSummary[]>(r)),
  create: (cfg: Partial<RunConfig>) =>
    fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) }).then((r) =>
      json<{ id: string }>(r),
    ),
  cancel: (id: string) => fetch(`/api/runs/${id}/cancel`, { method: 'POST' }).then((r) => json(r)),
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
      next.messages = run.messages.map((m) => (m.id === e.id ? { ...m, status: e.status, verdict: e.verdict, endedAt: e.endedAt } : m));
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
