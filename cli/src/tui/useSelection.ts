import { useCallback, useEffect, useState } from 'react';
import type { PipelineDef, RoleDef } from '../../../server/src/types.ts';
import { getPipelines, getRoles } from '../../../server/src/settings.ts';
import { currentModeId, modeList, stepMode, type ModeEntry } from './modes.ts';
import type { SessionOverrides } from './panel-types.ts';
import type { ChatMode, Selection } from './requestBuilder.ts';

export interface SelectionApi {
  selection: Selection;
  roles: RoleDef[];
  pipelines: PipelineDef[];
  pipeline: PipelineDef | null;
  /** Every mode (Code, Plan, single-turn roles, pipelines) in Tab order, and the one in effect. */
  modes: ModeEntry[];
  modeId: string;
  /** Tab (1) and Shift+Tab (-1): the next or previous mode. */
  cycleMode(step: 1 | -1): void;
  pickRole(role: RoleDef | null): void;
  pickPipeline(id: string | null): void;
  pickOverrides(overrides: SessionOverrides): void;
  toggleSkipAuth(): boolean;
  /** Forget role, pipeline and overrides and set the mode (a resumed session starts clean). */
  resetTo(mode: ChatMode): void;
  /** Re-read roles and pipelines (after a panel may have edited them). */
  reload(): void;
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

  const modes = modeList(roles, pipelines);
  const modeId = currentModeId({ mode, role, pipelineId });

  const cycleMode = (step: 1 | -1) => {
    const next = stepMode(modes, modeId, step);
    if (!next) return;
    setPipelineId(next.pipeline?.id ?? null);
    setRole(next.role ?? null);
    setMode(next.id === 'plan' ? 'plan' : 'code');
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
    modes,
    modeId,
    cycleMode,
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
