import { useEffect, useState } from 'react';
import type { AgentName } from '../../server/src/agents/types.ts';
import type { Run, RunConfig, RoutePlan } from '../../server/src/types.ts';
import type { ModelCatalog } from '../../server/src/types.ts';
import { startRunStream } from './run-events.ts';

export type { Message, ModelChoice, PairDecision, Part, RoutePlan, Run, RunConfig, Verdict, Speaker } from '../../server/src/types.ts';
export type { AgentName, Usage } from '../../server/src/agents/types.ts';
export type { ModelCatalog, ModelInfo } from '../../server/src/types.ts';

/** What the form sends: a concrete mode, or 'auto' to let the router decide. */
export type NewRunRequest = Omit<Partial<RunConfig>, 'mode' | 'images'> & { mode: RunConfig['mode'] | 'auto'; images?: { name: string; dataUrl: string }[] };

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
  title?: string;
  mode: 'debate' | 'pair' | 'plan';
  prompt: string;
  cwd: string;
  status: Run['status'];
  createdAt: number;
  claudeLimits?: Record<string, { utilization: number; resetsAt?: number }>;
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
  rename: (id: string, title: string) => fetch(`/api/runs/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) }).then((r) => json<{ title: string }>(r)),
  delete: (id: string) => fetch(`/api/runs/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  getRun: async (id: string) => {
    const res = await fetch(`/api/runs/${id}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    return json<Run>(res);
  },
  create: (cfg: NewRunRequest) =>
    fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) }).then((r) =>
      json<{ id: string }>(r),
    ),
  continue: (id: string, prompt: string, images: NonNullable<NewRunRequest['images']>, config: Partial<NewRunRequest> = {}) =>
    fetch(`/api/runs/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...config, prompt, images, mode: config.mode ?? 'auto' }) }).then((r) => json<{ id: string }>(r)),
  previewRoute: (prompt: string, signal?: AbortSignal) =>
    fetch('/api/route/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }), signal }).then((r) =>
      json<RoutePreview>(r),
    ),
  cancel: (id: string) =>
    fetch(`/api/runs/${id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) =>
      json(r),
    ),
  pairDecision: (id: string, continueRun: boolean) =>
    fetch(`/api/runs/${id}/pair-decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ continue: continueRun }) }).then((r) =>
      json<{ ok: boolean }>(r),
    ),
};

/** Live view of a run: snapshot + streamed events over SSE. */
export function useRun(id: string, revision = 0) {
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
  }, [id, revision]);

  return { run, reconnecting, error };
}
