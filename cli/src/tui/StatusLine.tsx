import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import type { Usage } from '../../../server/src/agents/types.ts';
import type { PipelineDef, RoleDef } from '../../../server/src/types.ts';
import type { SessionOverrides } from './panel-types.ts';
import { effectiveMode, type Selection } from './requestBuilder.ts';
import { Spinner } from './Spinner.tsx';
import { tone } from './theme.ts';
import { formatDuration, formatUsageLine } from './thread.ts';
import type { Phase } from './useSession.ts';

export interface RoutePreview {
  coder: string;
  reviewer: string;
}

/** Seconds since `since` while `active`, ticking once a second (timer removed on unmount). */
export function useElapsed(since: number | null, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return since && active ? now - since : 0;
}

function routeLabel(route: RoutePreview | null): string {
  if (!route) return 'auto-routed';
  const agents = [...new Set([route.coder, route.reviewer])];
  return `auto: ${agents.join(' + ')}`;
}

/** "agent/model/effort" for what the next message would use. */
export function describeTarget(role: RoleDef | null, overrides: SessionOverrides, route: RoutePreview | null): string {
  const agent = overrides.agent ?? role?.agent;
  if (!agent) return routeLabel(route);
  const model = overrides.model ?? (overrides.agent ? undefined : role?.model);
  const effort = overrides.effort ?? (overrides.agent ? undefined : role?.effort);
  return [agent, model, effort].filter(Boolean).join('/');
}

function permissionOf(role: RoleDef | null, overrides: SessionOverrides): string {
  return overrides.permission ?? role?.permission ?? 'auto';
}

export interface StatusLineProps {
  selection: Selection;
  pipeline: PipelineDef | null;
  phase: Phase;
  awaiting: boolean;
  startedAt: number | null;
  usage?: Usage;
  route: RoutePreview | null;
}

function RunState({ phase, awaiting, elapsed }: Readonly<{ phase: Phase; awaiting: boolean; elapsed: number }>) {
  if (phase === 'idle') return <Text color={tone('green')}>ready</Text>;
  if (awaiting) return <Text color={tone('yellow')}>waiting for your decision</Text>;
  return (
    <Text color={tone('cyan')}>
      <Spinner /> {phase === 'starting' ? 'starting' : 'running'} {formatDuration(elapsed)}
    </Text>
  );
}

const HINTS: Record<Phase | 'awaiting', string> = {
  idle: 'Enter send · Tab role · Shift+Tab Code/Plan · / commands · Ctrl+C exit',
  starting: 'Ctrl+C stop',
  running: '/ commands · Ctrl+C stop',
  awaiting: '↑↓ Enter choose · Ctrl+C stop',
};

export function StatusLine({ selection, pipeline, phase, awaiting, startedAt, usage, route }: Readonly<StatusLineProps>) {
  const elapsed = useElapsed(startedAt, phase !== 'idle' && !awaiting);
  const mode = effectiveMode(selection);
  const { role, overrides } = selection;
  const usageText = formatUsageLine(usage);
  const hint = HINTS[awaiting ? 'awaiting' : phase];
  return (
    <Box flexDirection="column">
      <Box columnGap={1} flexWrap="wrap">
        <Text bold inverse color={tone(mode === 'plan' ? 'yellow' : 'cyan')}>{` ${mode.toUpperCase()} `}</Text>
        {role ? <Text>{`${role.icon} ${role.name}`}</Text> : null}
        {pipeline ? <Text>{`⛓ ${pipeline.name}`}</Text> : null}
        {pipeline ? null : <Text dimColor>{`${describeTarget(role, overrides, route)} · ${permissionOf(role, overrides)}`}</Text>}
        <RunState phase={phase} awaiting={awaiting} elapsed={elapsed} />
        {usageText ? <Text dimColor>{usageText}</Text> : null}
        {selection.skipAuthCheck ? <Text color={tone('yellow')}>skip-auth</Text> : null}
      </Box>
      <Text dimColor>{hint}</Text>
    </Box>
  );
}
