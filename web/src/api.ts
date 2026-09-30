import { useEffect, useState } from 'react';
import type { AgentName } from '../../server/src/agents/types.ts';
import type { CliSettings, ConnectionStatus, Mode, ModelCatalog, UsageReport, PipelineDef, Run, RunConfig, RoleDef, RoutePlan } from '../../server/src/types.ts';
import { startRunStream } from './run-events.ts';

export type { Message, ModelChoice, PairDecision, PlanDecision, Part, RoutePlan, Run, RunConfig, Verdict, Speaker } from '../../server/src/types.ts';
export type { AgentName, Usage } from '../../server/src/agents/types.ts';
export type { CliConfig, CliSettings, Mode, ModelCatalog, ModelInfo, PipelineDef, PipelineStep, Permission, RoleDef } from '../../server/src/types.ts';
export type { AgentUsage, ConnectionStatus, UsageReport, UsageResetCredit, UsageWindow } from '../../server/src/types.ts';

/** The router selects agents within the selected mode. */
export type NewRunRequest = Omit<Partial<RunConfig>, 'mode' | 'images'> & { mode: Mode; images?: { name: string; dataUrl: string }[] };

export interface RoutePreview {
  mode: Mode;
  coder: AgentName;
  reviewer: AgentName;
  maxRounds: number;
  route: RoutePlan;
  /** The rules aren't sure; starting the run will ask Haiku first. */
  askHaiku: boolean;
}

export interface RunSummary {
  id: string;
  title?: string;
  mode: RunConfig['mode'];
  agent: AgentName;
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

export interface AgentTestResult {
  agent: AgentName;
  ok: boolean;
  problems: string[];
  authUnverified: boolean;
  version: { version: string | null; path: string | null; error: string | null };
}

export interface FileEntry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
}

export interface CliDetect {
  name: AgentName;
  resolvedPath: string | null;
  source: 'env' | 'settings' | 'path' | 'known' | 'none';
  version: string | null;
  error: string | null;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

export const api = {
  usage: (refresh = false) => fetch(refresh ? '/api/usage?refresh=1' : '/api/usage', { cache: 'no-store' }).then((r) => json<UsageReport>(r)),
  connection: (name: AgentName) => fetch(`/api/agents/${name}/connection`, { cache: 'no-store' }).then((r) => json<ConnectionStatus>(r)),
  openLogin: (name: AgentName) => fetch(`/api/agents/${name}/login`, { method: 'POST', headers: JSON_HEADERS, body: '{}' }).then((r) => json<{ ok: true }>(r)),
  testAgent: (name: AgentName) => fetch(`/api/agents/${name}/test`, { method: 'POST', headers: JSON_HEADERS, body: '{}' }).then((r) => json<AgentTestResult>(r)),
  cliSettings: () => fetch('/api/cli-settings', { cache: 'no-store' }).then((r) => json<{ cli: CliSettings }>(r)),
  saveCliSettings: (cli: CliSettings) => fetch('/api/cli-settings', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ cli }) }).then((r) => json<{ cli: CliSettings }>(r)),
  detectCli: (name: AgentName) => fetch(`/api/cli-settings/detect/${name}`, { cache: 'no-store' }).then((r) => json<CliDetect>(r)),
  roles: () => fetch('/api/roles').then((r) => json<{ roles: RoleDef[] }>(r)),
  saveRoles: (roles: RoleDef[]) => fetch('/api/roles', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ roles }) }).then((r) => json<{ roles: RoleDef[] }>(r)),
  resetRoles: () => fetch('/api/roles/reset', { method: 'POST', headers: JSON_HEADERS, body: '{}' }).then((r) => json<{ roles: RoleDef[] }>(r)),
  pipelines: () => fetch('/api/pipelines').then((r) => json<{ pipelines: PipelineDef[] }>(r)),
  savePipelines: (pipelines: PipelineDef[]) => fetch('/api/pipelines', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ pipelines }) }).then((r) => json<{ pipelines: PipelineDef[] }>(r)),
  files: (cwd: string, dir = '') => fetch(`/api/files?cwd=${encodeURIComponent(cwd)}&dir=${encodeURIComponent(dir)}`).then((r) => json<{ entries: FileEntry[]; truncated: boolean }>(r)),
  file: (cwd: string, filePath: string) => fetch(`/api/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`).then((r) => json<{ path: string; size: number; content: string; truncated: boolean }>(r)),
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
    fetch(`/api/runs/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...config, prompt, images, mode: config.mode ?? 'code' }) }).then((r) => json<{ id: string }>(r)),
  previewRoute: (prompt: string, mode: Mode, signal?: AbortSignal) =>
    fetch('/api/route/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, mode }), signal }).then((r) =>
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
  planDecision: (id: string, action: 'approve' | 'stop' | 'refine', feedback?: string) =>
    fetch(`/api/runs/${id}/plan-decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, feedback }) }).then((r) =>
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
