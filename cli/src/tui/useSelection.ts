import { useCallback, useEffect, useState } from 'react';
import type { ModeModel, PipelineDef, RoleDef } from '../../../server/src/types.ts';
import { getCliSettings, getPipelines, getRoles, setCliSettings } from '../../../server/src/settings.ts';
import { currentModeId, modeList, stepMode, type ModeEntry } from './modes.ts';
import type { SessionOverrides } from './panel-types.ts';
import type { ChatMode, Selection } from './requestBuilder.ts';

type OverridesByMode = Record<string, SessionOverrides>;

/** The stored model choice of a mode as the composer's overrides. */
const toOverrides = (stored: ModeModel): SessionOverrides => ({ ...stored });

/** What is kept of a mode's overrides: the choice itself (an "auto" mark is the default and is not stored). */
function toStored(overrides: SessionOverrides): ModeModel {
  const { agent, reviewer, model, effort, permission } = overrides;
  return { ...(agent && { agent }), ...(reviewer && { reviewer }), ...(model && { model }), ...(effort && { effort }), ...(permission && { permission }) };
}

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

const NO_OVERRIDES: SessionOverrides = {};

/** Mode, role, pipeline and per-message overrides the composer sends with the next message. */
export function useSelection(): SelectionApi {
  const [mode, setMode] = useState<ChatMode>('code');
  const [role, setRole] = useState<RoleDef | null>(null);
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  // Model, agent and permission choices belong to a mode: Tab to another mode brings that mode's own back.
  const [overridesByMode, setOverridesByMode] = useState<OverridesByMode>({});
  const [skipAuthCheck, setSkipAuthCheck] = useState(false);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [pipelines, setPipelines] = useState<PipelineDef[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    void getCliSettings().then(
      (cli) => live && setOverridesByMode((cur) => ({ ...Object.fromEntries(Object.entries(cli.modeModels ?? {}).map(([id, stored]) => [id, toOverrides(stored)])), ...cur })),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

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
  const overrides = overridesByMode[modeId] ?? NO_OVERRIDES;

  /** Sets the model choice of the mode in effect and keeps it for the next sessions. */
  const pickOverrides = (next: SessionOverrides) => {
    const id = modeId;
    setOverridesByMode((cur) => ({ ...cur, [id]: next }));
    void getCliSettings()
      .then((cli) => {
        const modeModels = { ...cli.modeModels };
        const stored = toStored(next);
        if (Object.keys(stored).length > 0) modeModels[id] = stored;
        else delete modeModels[id];
        return setCliSettings({ ...cli, modeModels });
      })
      .catch(() => {});
  };

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
    pickOverrides,
    toggleSkipAuth,
    resetTo: (next) => {
      setMode(next);
      setRole(null);
      setPipelineId(null);
      // A resumed session follows its own run: the chosen agents of the modes are not applied to it (they stay saved).
      setOverridesByMode((cur) => ({ ...cur, [next]: {} }));
    },
    reload: () => setVersion((v) => v + 1),
  };
}
