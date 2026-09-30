import { useCallback, useEffect, useState } from 'react';
import type { PipelineDef, RoleDef } from '../../../server/src/types.ts';
import { getPipelines, getRoles } from '../../../server/src/settings.ts';
import type { SessionOverrides } from './panel-types.ts';
import type { ChatMode, Selection } from './requestBuilder.ts';

export interface SelectionApi {
  selection: Selection;
  roles: RoleDef[];
  pipelines: PipelineDef[];
  pipeline: PipelineDef | null;
  cycleRole(): void;
  toggleMode(): void;
  pickRole(role: RoleDef | null): void;
  pickPipeline(id: string | null): void;
  pickOverrides(overrides: SessionOverrides): void;
  toggleSkipAuth(): boolean;
  /** Forget role, pipeline and overrides and set the mode (a resumed session starts clean). */
  resetTo(mode: ChatMode): void;
  /** Re-read roles and pipelines (after a panel may have edited them). */
  reload(): void;
}

/** Next role in Tab order: none -> first role -> … -> last role -> none. */
export function nextRole(roles: readonly RoleDef[], current: RoleDef | null): RoleDef | null {
  if (roles.length === 0) return null;
  if (!current) return roles[0];
  const index = roles.findIndex((r) => r.id === current.id);
  return index < 0 || index === roles.length - 1 ? null : roles[index + 1];
}

/** Mode, role, pipeline and per-message overrides the composer sends with the next message. */
export function useSelection(): SelectionApi {
  const [mode, setMode] = useState<ChatMode>('code');
  const [role, setRole] = useState<RoleDef | null>(null);
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<SessionOverrides>({});
  const [skipAuthCheck, setSkipAuthCheck] = useState(false);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [pipelines, setPipelines] = useState<PipelineDef[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    void Promise.all([getRoles(), getPipelines()]).then(
      ([r, p]) => {
        if (!live) return;
        setRoles(r);
        setPipelines(p);
        // A role or pipeline deleted in a panel no longer applies.
        setRole((cur) => (cur ? (r.find((x) => x.id === cur.id) ?? null) : cur));
        setPipelineId((cur) => (cur && !p.some((x) => x.id === cur) ? null : cur));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [version]);

  const pickRole = useCallback((next: RoleDef | null) => {
    setRole(next);
    if (next) {
      setMode('code');
      setPipelineId(null);
    }
  }, []);

  const cycleRole = () => pickRole(nextRole(roles, role));

  const toggleMode = () => {
    const next: ChatMode = mode === 'plan' && !pipelineId ? 'code' : 'plan';
    setMode(next);
    setPipelineId(null);
    if (next === 'plan') setRole(null);
  };

  const pickPipeline = (id: string | null) => {
    setPipelineId(id);
    if (id) setRole(null);
  };

  const toggleSkipAuth = () => {
    setSkipAuthCheck(!skipAuthCheck);
    return !skipAuthCheck;
  };

  return {
    selection: { mode, role, pipelineId, overrides, skipAuthCheck },
    roles,
    pipelines,
    pipeline: pipelines.find((p) => p.id === pipelineId) ?? null,
    cycleRole,
    toggleMode,
    pickRole,
    pickPipeline,
    pickOverrides: setOverrides,
    toggleSkipAuth,
    resetTo: (next) => {
      setMode(next);
      setRole(null);
      setPipelineId(null);
      setOverrides({});
    },
    reload: () => setVersion((v) => v + 1),
  };
}
