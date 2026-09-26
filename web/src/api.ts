import { useEffect, useState } from 'react';
import type { AgentName } from '../../server/src/agents/types.ts';
import type { Run, RunConfig, RoutePlan } from '../../server/src/types.ts';
import type { ModelCatalog } from '../../server/src/types.ts';
import { startRunStream } from './run-events.ts';

export type { Message, ModelChoice, Part, RoutePlan, Run, RunConfig, Verdict, Speaker } from '../../server/src/types.ts';
export type { AgentName, Usage } from '../../server/src/agents/types.ts';
export type { ModelCatalog, ModelInfo } from '../../server/src/types.ts';

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
  cwd: string;
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
  models: () => fetch('/api/models').then((r) => json<ModelCatalog>(r)),
  list: () => fetch('/api/runs').then((r) => json<RunSummary[]>(r)),
  getRun: async (id: string) => {
    const res = await fetch(`/api/runs/${id}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    return json<Run>(res);
  },
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

/** Live view of a run: snapshot + streamed events over SSE. */
export function useRun(id: string) {
  const [run, setRun] = useState<Run | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRun(null);
    setReconnecting(false);
    setError(null);
    return startRunStream(id, {
      isRunMissing: async () => (await api.getRun(id)) === null,
      onRun: setRun,
      onReconnecting: setReconnecting,
      onError: setError,
    });
  }, [id]);

  return { run, reconnecting, error };
}
