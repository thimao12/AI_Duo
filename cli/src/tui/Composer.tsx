import { Box, Text, useInput, usePaste, type Key } from 'ink';
import { useEffect, useRef, useState } from 'react';
import type { RoleDef } from '../../../server/src/types.ts';
import {
  after,
  applyEditKey,
  backspace,
  cursorPosition,
  EMPTY_EDITOR,
  editorOf,
  insertText,
  lineCount,
  moveVertical,
  type EditorState,
} from './editor.ts';
import type { SlashCommand } from './panel-types.ts';
import { filterCommands } from './slash.ts';
import { isScrollKey } from './scroll.ts';
import { tone } from './theme.ts';

/** Slash menu text: "/" plus letters, on one line. */
export function slashQuery(text: string): string | undefined {
  if (!text.startsWith('/') || text.includes('\n') || text.includes(' ')) return undefined;
  return text.slice(1);
}

export const SHELL_HINT = 'shell mode · Enter runs · Esc or Backspace on empty exits';

const BACKSLASH = String.fromCodePoint(92);

/** Enter with a trailing backslash continues the line instead of sending. */
export function continuesLine(text: string, cursor: number): boolean {
  return cursor === text.length && text.endsWith(BACKSLASH) && !text.endsWith(BACKSLASH + BACKSLASH);
}

/* ---- Views ---- */

function RoleChips({ roles, role, plainLabel }: Readonly<{ roles: readonly RoleDef[]; role: RoleDef | null; plainLabel: string }>) {
  if (roles.length === 0) return null;
  return (
    <Box flexWrap="wrap" columnGap={1}>
      <Text dimColor>{plainLabel}</Text>
      {roles.map((r) => (
        <Text key={r.id} inverse={r.id === role?.id} dimColor={r.id !== role?.id}>
          {` ${r.name} `}
        </Text>
      ))}
    </Box>
  );
}

function SlashMenu({ matches, selected }: Readonly<{ matches: readonly SlashCommand[]; selected: number }>) {
  const shown = matches.slice(0, 8);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {shown.map((c, i) => (
        <Text key={c.name} color={i === selected ? tone('cyan') : undefined} bold={i === selected}>
          {`${i === selected ? '›' : ' '} /${c.name.padEnd(10)}`}
          <Text dimColor>{c.description}</Text>
        </Text>
      ))}
      {matches.length > shown.length ? <Text dimColor>{`  … ${matches.length - shown.length} more`}</Text> : null}
    </Box>
  );
}

interface EditorLine {
  id: number;
  text: string;
}

const MAX_VISIBLE_LINES = 8;

interface EditorViewProps {
  state: EditorState;
  placeholder: string;
  active: boolean;
  /** Prompt glyph on the first line: '›' for a message, '!' in shell mode. */
  glyph: string;
  glyphTone: 'cyan' | 'magenta';
}

function EditorView({ state, placeholder, active, glyph, glyphTone }: Readonly<EditorViewProps>) {
  const { row, col } = cursorPosition(state);
  const lines: EditorLine[] = state.text.split('\n').map((text, id) => ({ id, text }));
  const first = Math.max(0, Math.min(row - MAX_VISIBLE_LINES + 1, lines.length - MAX_VISIBLE_LINES));
  const visible = lines.slice(first, first + MAX_VISIBLE_LINES);
  const empty = state.text === '';
  return (
    <Box flexDirection="column">
      {first > 0 ? <Text dimColor>{`… ${first} line(s) above`}</Text> : null}
      {visible.map((line) => {
        const here = line.id === row;
        const at = line.text.slice(col, after(line.text, col)) || ' ';
        const rest = here ? line.text.slice(col + at.length) : '';
        return (
          <Box key={line.id}>
            <Text color={tone(glyphTone)} bold>{line.id === 0 ? `${glyph} ` : '  '}</Text>
            {here ? (
              <Text>
                {line.text.slice(0, col)}
                <Text inverse={active}>{at}</Text>
                {rest}
                {empty ? <Text dimColor>{` ${placeholder}`}</Text> : null}
              </Text>
            ) : (
              <Text>{line.text || ' '}</Text>
            )}
          </Box>
        );
      })}
      {first + visible.length < lines.length ? <Text dimColor>{`… ${lines.length - first - visible.length} line(s) below`}</Text> : null}
    </Box>
  );
}

/* ---- Behaviour ---- */

export interface ComposerProps {
  /** Older prompts, newest last (Up/Down walk through them). */
  history?: readonly string[];
  roles?: readonly RoleDef[];
  role?: RoleDef | null;
  commands?: readonly SlashCommand[];
  /** Keyboard capture on/off (off while a panel or a decision owns the keys). */
  active?: boolean;
  placeholder?: string;
  /** Plain text entry: no slash menu, history or role/mode keys (decision feedback). */
  plain?: boolean;
  borderTone?: 'cyan' | 'yellow' | 'magenta';
  /** Returns an error to show under the box (the text is put back), or null when accepted. */
  onSubmit(text: string): Promise<string | null> | string | null;
  onCommand?(command: SlashCommand): void;
  onCycleRole?(): void;
  onToggleMode?(): void;
  onDraft?(text: string): void;
  /** Ctrl+D on an empty box. */
  onExit?(): void;
  /** Esc, when the box has nothing to close itself. */
  onEscape?(): void;
  /** Runs a shell-mode command; returns an error to show (the text is put back), or null when it started. Omitted: no shell mode. */
  onShell?(command: string): Promise<string | null> | string | null;
  /** A reason shell mode cannot start right now (an agent run is active), or null. */
  shellBlocked?(): string | null;
  /** Tells the app whether the box is in shell mode. */
  onShellMode?(on: boolean): void;
  /** Full screen: PageUp/PageDown and Ctrl/Alt+arrows, Home, End belong to the thread viewport, not to this box. */
  reserveScrollKeys?: boolean;
}

/** `showText` puts a history entry into the box (an entry starting with ! re-enters shell mode). */
function useHistoryWalk(history: readonly string[], showText: (text: string) => void) {
  const index = useRef(-1);
  const draft = useRef('');
  const reset = () => {
    index.current = -1;
  };
  const show = (at: number, text: string) => {
    index.current = at;
    showText(text);
  };
  /** Older (-1) or newer (+1); returns false when there is nowhere to go. */
  const walk = (dir: -1 | 1, current: string): boolean => {
    if (history.length === 0) return false;
    if (dir === -1) {
      if (index.current === 0) return true;
      if (index.current === -1) draft.current = current;
      const next = index.current === -1 ? history.length - 1 : index.current - 1;
      show(next, history[next]);
      return true;
    }
    if (index.current === -1) return false;
    const next = index.current + 1;
    if (next >= history.length) show(-1, draft.current);
    else show(next, history[next]);
    return true;
  };
  return { walk, reset };
}

function isNewlineKey(input: string, key: Key): boolean {
  return input === '\n' || (key.return && (key.shift || key.meta));
}

export function Composer(props: Readonly<ComposerProps>) {
  const { history = [], roles = [], role = null, commands = [], active = true, plain = false, placeholder = 'Ask anything, or type / for commands' } = props;
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [error, setError] = useState<string | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  // An IME can deliver several key events in one tick (Backspace bursts followed by the re-composed
  // letters). Every event must see the result of the previous one, not the last rendered state.
  const latest = useRef<EditorState>(EMPTY_EDITOR);
  const menuAt = useRef(0);
  const putEditor = (next: EditorState) => {
    latest.current = next;
    setEditor(next);
  };
  const putMenu = (at: number) => {
    menuAt.current = at;
    setMenuIndex(at);
  };
  // Shell mode is mirrored in a ref for the same reason as the editor: several key events can arrive in one tick.
  const [shell, setShell] = useState(false);
  const shellRef = useRef(false);
  const putShell = (on: boolean) => {
    shellRef.current = on;
    setShell(on);
  };
  const shellEnabled = !plain && props.onShell !== undefined;
  const showEntry = (text: string) => {
    const asShell = shellEnabled && text.startsWith('!');
    putShell(asShell);
    putEditor(editorOf(asShell ? text.slice(1) : text));
  };
  const walker = useHistoryWalk(history, showEntry);
  const { onDraft, onShellMode } = props;

  useEffect(() => {
    onDraft?.(editor.text);
  }, [editor.text, onDraft]);

  useEffect(() => {
    onShellMode?.(shell);
    return () => onShellMode?.(false);
  }, [shell, onShellMode]);

  const matchesFor = (text: string): SlashCommand[] => {
    const query = plain || shellRef.current ? undefined : slashQuery(text);
    return query === undefined ? [] : filterCommands(commands, query);
  };
  const matches = matchesFor(editor.text);
  const menuOpen = matches.length > 0;
  const selected = Math.min(menuIndex, Math.max(0, matches.length - 1));

  const edit = (next: EditorState) => {
    putEditor(next);
    setError(null);
    putMenu(0);
    walker.reset();
  };

  const leaveShell = () => {
    putShell(false);
    edit(EMPTY_EDITOR);
  };

  /** Typed or pasted text: a ! at the very start of an empty box switches to shell mode (the ! is consumed). */
  const accept = (next: EditorState) => {
    const startsShell = shellEnabled && !shellRef.current && latest.current.text === '' && next.text.startsWith('!');
    if (!startsShell) {
      edit(next);
      return;
    }
    const blocked = props.shellBlocked?.() ?? null;
    if (blocked) {
      edit(next);
      setError(blocked);
      return;
    }
    putShell(true);
    edit({ text: next.text.slice(1), cursor: Math.max(0, next.cursor - 1) });
  };

  const submit = async () => {
    const text = latest.current.text.trim();
    if (!text) return;
    const handler = shellRef.current && props.onShell ? props.onShell : props.onSubmit;
    putEditor(EMPTY_EDITOR);
    walker.reset();
    const problem = await handler(text);
    setError(problem);
    if (problem && !latest.current.text) putEditor(editorOf(text));
  };

  const runCommand = (command: SlashCommand) => {
    putEditor(EMPTY_EDITOR);
    props.onCommand?.(command);
  };

  /** Keys of the open slash menu; true when consumed. */
  const menuKey = (key: Key): boolean => {
    const open = matchesFor(latest.current.text);
    if (open.length === 0) return false;
    const at = Math.min(menuAt.current, open.length - 1);
    if (key.upArrow || key.downArrow) {
      putMenu((at + (key.upArrow ? -1 : 1) + open.length) % open.length);
    } else if (key.tab && !key.shift) {
      edit(editorOf(`/${open[at].name}`));
    } else if (key.return && !key.shift && !key.meta) {
      runCommand(open[at]);
    } else {
      return false;
    }
    return true;
  };

  const enterKey = (input: string, key: Key): boolean => {
    const cur = latest.current;
    if (isNewlineKey(input, key)) {
      edit(insertText(cur, '\n'));
    } else if (key.return && !shellRef.current && continuesLine(cur.text, cur.cursor)) {
      edit(insertText(backspace(cur), '\n'));
    } else if (key.return) {
      void submit();
    } else {
      return false;
    }
    return true;
  };

  const tabKey = (key: Key) => {
    if (key.shift) props.onToggleMode?.();
    else if (latest.current.text === '') props.onCycleRole?.();
  };

  const arrowKey = (key: Key) => {
    const step = key.upArrow ? -1 : 1;
    const moved = moveVertical(latest.current, step);
    if (moved) putEditor(moved);
    else walker.walk(step, latest.current.text);
  };

  const specialKey = (input: string, key: Key): boolean => {
    if (key.ctrl && input === 'd' && latest.current.text === '') {
      props.onExit?.();
    } else if (key.escape && shellRef.current) {
      leaveShell();
    } else if (key.escape) {
      props.onEscape?.();
    } else if (key.tab && !plain && !shellRef.current) {
      tabKey(key);
    } else if ((key.upArrow || key.downArrow) && !plain) {
      arrowKey(key);
    } else {
      return false;
    }
    return true;
  };

  useInput(
    (input, key) => {
      if (key.eventType === 'release' || (key.ctrl && input === 'c')) return;
      if (props.reserveScrollKeys && isScrollKey(key)) return;
      if (shellRef.current && key.backspace && latest.current.text === '') {
        leaveShell();
        return;
      }
      if (menuKey(key) || enterKey(input, key) || specialKey(input, key)) return;
      const next = applyEditKey(latest.current, input, key);
      if (next) accept(next);
    },
    { isActive: active },
  );

  // Bracketed paste arrives whole: it can never submit half-way.
  usePaste((text) => accept(insertText(latest.current, text)), { isActive: active });

  const borderColor = tone(shell ? 'magenta' : (props.borderTone ?? 'cyan'));
  return (
    <Box flexDirection="column">
      {plain ? null : <RoleChips roles={roles} role={role} plainLabel="role:" />}
      <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
        <EditorView state={editor} placeholder={shell ? 'command to run in the session folder' : placeholder} active={active} glyph={shell ? '!' : '›'} glyphTone={shell ? 'magenta' : 'cyan'} />
      </Box>
      {menuOpen ? <SlashMenu matches={matches} selected={selected} /> : null}
      {error ? <Text color={tone('red')}>{error}</Text> : null}
      {shell ? <Text dimColor>{SHELL_HINT}</Text> : null}
      {!shell && lineCount(editor) > 1 ? <Text dimColor>Enter sends · Alt+Enter, Ctrl+J or trailing \ for a new line</Text> : null}
    </Box>
  );
}
