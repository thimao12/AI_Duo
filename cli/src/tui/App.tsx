import { Box, Static, Text, useApp, useInput, useWindowSize } from 'ink';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useInterrupt, usePreflight, useRoutePreview } from './appHooks.ts';
import { Composer } from './Composer.tsx';
import { PairDecisionPrompt, PlanDecisionPrompt } from './DecisionPrompt.tsx';
import { addToHistory, saveHistory } from './history.ts';
import type { PanelProps, SlashCommand } from './panel-types.ts';
import type { ClipboardReader } from './clipboard.ts';
import type { ImageAttachment } from './images.ts';
import { historyText } from './imageTokens.ts';
import { buildRequest, effectiveMode } from './requestBuilder.ts';
import { findCommand, HELP_LINES, SLASH_COMMANDS } from './slash.ts';
import { StatusLine } from './StatusLine.tsx';
import { tone, usableWidth } from './theme.ts';
import { FinishedThread, FullscreenHeader, LiveThread, ThreadItemView, windowLog } from './ThreadView.tsx';
import { useSelection, type SelectionApi } from './useSelection.ts';
import { useSession, type ChatService, type Session } from './useSession.ts';
import { useShell } from './useShell.ts';
import { Viewport } from './Viewport.tsx';
import { PanelRowsContext } from './widgets/rows.ts';

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
  /** Full screen (fixed layout, scrollable thread) or inline (thread in the terminal's scrollback). Default inline. */
  screen?: 'fullscreen' | 'inline';
  /** Reads an image from the OS clipboard (tests inject a fake). */
  readClipboard?: ClipboardReader;
  /** Called with the id of the run this window is on (for the resume hint printed at exit). */
  onRunChange?: (runId: string | undefined) => void;
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
  return (
    <Box flexDirection="column" flexShrink={0}>
      {command.panel?.(props)}
    </Box>
  );
}

const SHELL_BLOCKED = 'Shell mode is unavailable while an agent run is active. Wait for it, or press Ctrl+C to stop it.';

function helpText(): string {
  const commands = SLASH_COMMANDS.map((c) => `  /${c.name.padEnd(12)} ${c.description}`);
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
  const fullscreen = props.screen === 'fullscreen';
  const session = useSession(service, { cwd, branch: props.branch, version: props.version }, !fullscreen);
  const selection = useSelection();
  const [panel, setPanel] = useState<SlashCommand | null>(null);
  const [history, setHistory] = useState(props.history);
  const [draft, setDraft] = useState('');
  const [shellMode, setShellMode] = useState(false);
  const [followTick, setFollowTick] = useState(0);
  const { onRunChange } = props;
  const runId = session.run?.id;
  useEffect(() => {
    onRunChange?.(runId);
  }, [onRunChange, runId]);

  const problems = usePreflight(service, cwd, selection.selection.skipAuthCheck === true, !props.skipPreflight);
  const autoRouted = !selection.selection.role && !selection.selection.pipelineId && !selection.selection.overrides.agent;
  const shellRun = useShell(cwd, session.push, session.notice);
  const route = useRoutePreview(service, draft, selection.selection.mode, autoRouted && session.phase === 'idle' && !shellMode);
  useInterrupt({ phase: session.phase, shellRunning: shellRun.running, killShell: shellRun.kill, cancel: session.cancel, exit, notice: (t) => session.notice('warn', t) });

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

  /** Shell mode: run the command here; it is kept in the history with a leading ! and never reaches the agents. */
  const submitShell = (command: string): string | null => {
    if (session.phase !== 'idle') return SHELL_BLOCKED;
    const failure = shellRun.run(command);
    if (failure) return failure;
    setFollowTick((t) => t + 1);
    rememberPrompt(`!${command}`);
    return null;
  };

  const submit = async (text: string, images: readonly ImageAttachment[] = []): Promise<string | null> => {
    if (text.startsWith('/')) return runSlash(text, shell);
    if (session.phase !== 'idle') return 'A run is in progress. Wait for it, or press Ctrl+C to stop it.';
    if (shellRun.running) return 'A shell command is running. Wait for it, or press Ctrl+C to stop it.';
    setFollowTick((t) => t + 1);
    const failure = await session.send(buildRequest(selection.selection, text, cwd, images), text);
    if (!failure && text) rememberPrompt(historyText(text));
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

  const decision = awaiting && session.handle && session.run ? <DecisionArea session={session} /> : null;
  const panelNode = !awaiting && panel ? <PanelHost command={panel} props={panelProps} /> : null;
  const composer =
    !awaiting && !panel ? (
      <Composer
        history={history}
        roles={selection.roles}
        role={selection.selection.role}
        commands={SLASH_COMMANDS}
        cwd={cwd}
        readClipboard={props.readClipboard}
        borderTone={effectiveMode(selection.selection) === 'plan' ? 'yellow' : 'cyan'}
        onSubmit={submit}
        onShell={submitShell}
        shellBlocked={() => (session.phase === 'idle' ? null : SHELL_BLOCKED)}
        onShellMode={setShellMode}
        onCommand={(c) => {
          const error = runSlash(`/${c.name}`, shell);
          if (error) session.notice('error', error);
        }}
        onCycleRole={selection.cycleRole}
        onToggleMode={selection.toggleMode}
        onDraft={setDraft}
        onExit={exit}
        reserveScrollKeys={fullscreen}
      />
    ) : null;
  const status = (
    <StatusLine
      selection={selection.selection}
      pipeline={selection.pipeline}
      phase={session.phase}
      awaiting={awaiting}
      startedAt={session.startedAt}
      usage={session.run?.usage}
      route={route}
      shellMode={shellMode}
      shellRunning={shellRun.running}
    />
  );
  const shellLive = shellRun.live ? <ThreadItemView item={shellRun.live} width={width} maxLines={Math.max(4, (rows ?? 24) - 14)} /> : null;
  const banner = <Banner problems={problems} />;

  if (!fullscreen) {
    const bottom = (
      <>
        {decision}
        {panelNode}
        {composer}
      </>
    );
    return <InlineLayout session={session} width={width} rows={rows ?? 24} banner={banner} shellLive={shellLive} bottom={bottom} status={status} />;
  }
  return (
    <FullscreenLayout
      session={session}
      header={{ version: props.version, cwd, branch: props.branch }}
      columns={columns ?? 80}
      rows={rows ?? 24}
      width={width}
      banner={banner}
      shellLive={shellLive}
      panel={panelNode}
      bottom={decision ?? composer}
      status={status}
      followTick={followTick}
      edgeKeys={draft === ''}
    />
  );
}

interface LayoutProps {
  session: Session;
  width: number;
  rows: number;
  banner: ReactNode;
  /** The shell-mode command that is running, with its output so far. */
  shellLive: ReactNode;
  bottom: ReactNode;
  status: ReactNode;
}

/** Inline: finished items go to the terminal's scrollback through <Static>; the rest is redrawn below. */
function InlineLayout({ session, width, rows, banner, shellLive, bottom, status }: Readonly<LayoutProps>) {
  return (
    <Box flexDirection="column">
      <Static key={session.epoch} items={session.log}>
        {(item) => <ThreadItemView key={item.id} item={item} width={width} />}
      </Static>
      <LiveThread run={session.run} messages={session.live} width={width} rows={rows} />
      {shellLive}
      {banner}
      <Box marginTop={1} flexDirection="column">
        {bottom}
      </Box>
      {status}
    </Box>
  );
}

interface FullscreenLayoutProps extends Omit<LayoutProps, 'bottom'> {
  header: { version: string; cwd: string; branch?: string };
  columns: number;
  panel: ReactNode;
  bottom: ReactNode;
  followTick: number;
  edgeKeys: boolean;
}

/** Rows kept free: a frame that fills the whole terminal makes Ink clear and redraw it every time on Windows. */
const FRAME_MARGIN = 1;
const HEADER_ROWS = 2;
const STATUS_ROWS = 2;

/**
 * Full screen: fixed header on top, the thread in a scrollable viewport, then the panel or decision or
 * composer and the status line pinned at the bottom. A panel takes the viewport's place while it is open.
 */
function FullscreenLayout({ session, header, columns, rows, width, banner, shellLive, panel, bottom, status, followTick, edgeKeys }: Readonly<FullscreenLayoutProps>) {
  const frame = Math.max(1, rows - FRAME_MARGIN);
  const { items, hidden } = useMemo(() => windowLog(session.log), [session.log]);
  const panelOpen = panel !== null;
  return (
    <Box flexDirection="column" height={frame} width={columns}>
      <FullscreenHeader {...header} compact={rows < 14} />
      <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} display={panelOpen ? 'none' : 'flex'}>
        <Viewport resetKey={session.epoch} followTick={followTick} active={!panelOpen} edgeKeys={edgeKeys}>
          {banner}
          <FinishedThread items={items} hidden={hidden} width={width} />
          <LiveThread run={session.run} messages={session.live} width={width} rows={rows} />
          {shellLive}
        </Viewport>
      </Box>
      {panelOpen ? (
        <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">
          <PanelRowsContext.Provider value={Math.max(1, frame - HEADER_ROWS - STATUS_ROWS)}>{panel}</PanelRowsContext.Provider>
        </Box>
      ) : null}
      <Box flexDirection="column" flexShrink={0}>
        {bottom}
      </Box>
      {status}
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
