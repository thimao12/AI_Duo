import type { AgentName } from '../../../server/src/agents/types.ts';
import type { RoleDef } from '../../../server/src/types.ts';

/**
 * Contract between the TUI shell (App.tsx, slash.ts) and the slash-command panels in panels/.
 * A panel is a full-width Ink component shown in place of the composer until it calls onClose;
 * Esc always closes it. Panels read and write settings through the server modules directly
 * (settings.ts, usage.ts, connection.ts, service.ts): the CLI bundles the server core.
 */
export interface PanelProps {
  /** Working folder of the session. */
  cwd: string;
  onClose: () => void;
  /** Roles panel: make this role the active one for the next message (null clears it). */
  onPickRole?: (role: RoleDef | null) => void;
  /** Sessions panel: continue an earlier run in this window. */
  onPickSession?: (runId: string) => void;
  /** Pipelines panel: run a saved pipeline with the composer's next message as the task. */
  onPickPipeline?: (pipelineId: string | null) => void;
  /** Model panel: choose the agent/model/effort/permission overrides for the next message. */
  onPickOverrides?: (overrides: SessionOverrides) => void;
  /** Current overrides, so a picker can show the active choice. */
  overrides?: SessionOverrides;
  /** Active role, for display. */
  role?: RoleDef | null;
  /** Active pipeline id, for display. */
  pipelineId?: string | null;
}

export interface SessionOverrides {
  agent?: AgentName;
  model?: string;
  effort?: string;
  permission?: 'read' | 'edit';
}

/** One entry of the slash-command menu: typing "/" in the composer lists these. */
export interface SlashCommand {
  name: string;
  description: string;
  /** Opens this panel; omit for commands the shell handles itself (/clear, /exit, /new, /help). */
  panel?: (props: PanelProps) => import('react').ReactElement;
}
