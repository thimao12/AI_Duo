import { Box, Static, Text, useApp, useInput, useWindowSize } from 'ink';
import { useState } from 'react';
import { useInterrupt, usePreflight, useRoutePreview } from './appHooks.ts';
import { Composer } from './Composer.tsx';
import { PairDecisionPrompt, PlanDecisionPrompt } from './DecisionPrompt.tsx';
import { addToHistory, saveHistory } from './history.ts';
import type { PanelProps, SlashCommand } from './panel-types.ts';
import { buildRequest, effectiveMode } from './requestBuilder.ts';
import { findCommand, HELP_LINES, SLASH_COMMANDS } from './slash.ts';
import { StatusLine } from './StatusLine.tsx';
import { tone, usableWidth } from './theme.ts';
import { LiveThread, ThreadItemView } from './ThreadView.tsx';
import { useSelection, type SelectionApi } from './useSelection.ts';
import { useSession, type ChatService, type Session } from './useSession.ts';

export interface AppProps {
  service: ChatService;
  cwd: string;
  branch?: string;
  version: string;
  history: string[];
  /** Where prompt history is saved; omitted = not saved. */
  historyFile?: string;
  /** Skip the start-up agent check (tests). */
  skipPreflight?: boolean;
}

function Banner({ problems }: Readonly<{ problems: readonly string[] }>) {
  if (problems.length === 0) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tone('yellow')} paddingX={1} marginTop={1}>
      <Text color={tone('yellow')} bold>
        Some agent CLIs are not ready
      </Text>
      {problems.slice(0, 4).map((p) => (
        <Text key={p} dimColor>{`• ${p.split('\n')[0]}`}</Text>
      ))}
      <Text>Type /login to see how to install or log in to Claude and Codex.</Text>
    </Box>
  );
}

/** A panel replaces the composer until it closes; Esc always closes it. */
function PanelHost({ command, props }: Readonly<{ command: SlashCommand; props: PanelProps }>) {
  useInput((_input, key) => {
    if (key.escape) props.onClose();
  });
  return <Box flexDirection="column">{command.panel?.(props)}</Box>;
}

function helpText(): string {
  const commands = SLASH_COMMANDS.map((c) => `  /${c.name.padEnd(10)} ${c.description}`);
  return ['Commands:', ...commands, ...HELP_LINES].join('\n');
}

interface Shell {
  session: Session;
  selection: SelectionApi;
  exit(): void;
  openPanel(command: SlashCommand): void;
}

/** Commands the shell runs itself (no panel). Returns an error message for an unknown one. */
function runShellCommand(name: string, shell: Shell): string | null {
  const { session, selection } = shell;
  switch (name) {
    case 'help':
      session.notice('info', helpText());
      return null;
    case 'clear':
      session.clear();
      return null;
    case 'new':
      if (session.phase !== 'idle') return 'Stop the current run first (Ctrl+C).';
      session.reset();
      return null;
    case 'skip-auth':
      session.notice('warn', selection.toggleSkipAuth() ? 'Runs will start even if a CLI cannot report its login.' : 'Login check is strict again.');
      return null;
    case 'exit':
      shell.exit();
      return null;
    default:
      return `Unknown command /${name}. Type /help.`;
  }
}

function runSlash(text: string, shell: Shell): string | null {
  const name = text.slice(1).trim().split(' ')[0].toLowerCase();
  const command = findCommand(SLASH_COMMANDS, name);
  if (!command) return `Unknown command /${name}. Type /help.`;
  if (command.panel) {
    shell.openPanel(command);
    return null;
  }
  return runShellCommand(command.name, shell);
}

export function App(props: Readonly<AppProps>) {
  const { service, cwd } = props;
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const width = usableWidth(columns);
  const session = useSession(service, { cwd, branch: props.branch, version: props.version });
  const selection = useSelection();
  const [panel, setPanel] = useState<SlashCommand | null>(null);
  const [history, setHistory] = useState(props.history);
  const [draft, setDraft] = useState('');

  const problems = usePreflight(service, cwd, selection.selection.skipAuthCheck === true, !props.skipPreflight);
  const autoRouted = !selection.selection.role && !selection.selection.pipelineId && !selection.selection.overrides.agent;
  const route = useRoutePreview(service, draft, selection.selection.mode, autoRouted && session.phase === 'idle');
  useInterrupt({ phase: session.phase, cancel: session.cancel, exit, notice: (t) => session.notice('warn', t) });

  const awaiting = session.phase === 'running' && !!(session.run?.planDecision || session.run?.pairDecision);
  const closePanel = () => {
    setPanel(null);
    selection.reload();
  };
  const shell: Shell = { session, selection, exit, openPanel: setPanel };

  const rememberPrompt = (text: string) => {
    const next = addToHistory(history, text);
    setHistory(next);
    if (props.historyFile) void saveHistory(next, props.historyFile);
  };

  const submit = async (text: string): Promise<string | null> => {
    if (text.startsWith('/')) return runSlash(text, shell);
    if (session.phase !== 'idle') return 'A run is in progress. Wait for it, or press Ctrl+C to stop it.';
    const failure = await session.send(buildRequest(selection.selection, text, cwd), text);
    if (!failure) rememberPrompt(text);
    return failure;
  };

  const resume = async (runId: string) => {
    const result = await session.resume(runId);
    if (typeof result === 'string') {
      session.notice('error', result);
      return;
    }
    selection.resetTo(result.config.mode === 'plan' ? 'plan' : 'code');
    closePanel();
  };

  const panelProps: PanelProps = {
    cwd,
    onClose: closePanel,
    onPickRole: selection.pickRole,
    onPickSession: (id) => void resume(id),
    onPickPipeline: selection.pickPipeline,
    onPickOverrides: selection.pickOverrides,
    overrides: selection.selection.overrides,
    role: selection.selection.role,
    pipelineId: selection.selection.pipelineId,
  };

  return (
    <Box flexDirection="column">
      <Static key={session.epoch} items={session.log}>
        {(item) => <ThreadItemView key={item.id} item={item} width={width} />}
      </Static>
      <LiveThread run={session.run} messages={session.live} width={width} rows={rows ?? 24} />
      <Banner problems={problems} />
      <Box marginTop={1} flexDirection="column">
        {awaiting && session.handle && session.run ? <DecisionArea session={session} /> : null}
        {!awaiting && panel ? <PanelHost command={panel} props={panelProps} /> : null}
        {!awaiting && !panel ? (
          <Composer
            history={history}
            roles={selection.roles}
            role={selection.selection.role}
            commands={SLASH_COMMANDS}
            borderTone={effectiveMode(selection.selection) === 'plan' ? 'yellow' : 'cyan'}
            onSubmit={submit}
            onCommand={(c) => {
              const error = runSlash(`/${c.name}`, shell);
              if (error) session.notice('error', error);
            }}
            onCycleRole={selection.cycleRole}
            onToggleMode={selection.toggleMode}
            onDraft={setDraft}
            onExit={exit}
          />
        ) : null}
      </Box>
      <StatusLine
        selection={selection.selection}
        pipeline={selection.pipeline}
        phase={session.phase}
        awaiting={awaiting}
        startedAt={session.startedAt}
        usage={session.run?.usage}
        route={route}
      />
    </Box>
  );
}

function DecisionArea({ session }: Readonly<{ session: Session }>) {
  const { handle, run } = session;
  if (!handle || !run) return null;
  if (run.planDecision) return <PlanDecisionPrompt key={run.planDecision.revision} handle={handle} decision={run.planDecision} />;
  if (run.pairDecision) return <PairDecisionPrompt key={run.pairDecision.round} handle={handle} decision={run.pairDecision} />;
  return null;
}
