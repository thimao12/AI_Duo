import { Box, Text, useInput, usePaste, useWindowSize, type Key } from 'ink';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RoleDef } from '../../../server/src/types.ts';
import { readClipboardImage, type ClipboardReader } from './clipboard.ts';
import { LIMIT_NOTE, MAX_IMAGES, pastedImagePath, type ImageAttachment } from './images.ts';
import { attachmentSummary, displayToken, renumberForSend, segments, type Attached, type TokenSpan } from './imageTokens.ts';
import { loadPath, SHELL_IMAGE_NOTE, useImageLoader, type Loaded } from './useImages.ts';
import {
  after,
  applyEditKey,
  backspace,
  clearImages,
  cursorPosition,
  EMPTY_EDITOR,
  editorOf,
  insertImage,
  insertText,
  lineCount,
  moveVertical,
  spansOf,
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

/** Slash commands the box handles itself (it owns the attachments). */
const LOCAL_COMMANDS: ReadonlySet<string> = new Set(['paste-image', 'clear-images']);

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

/** One dim line under the box listing the attachments ("Image #1 shot.png PNG 184 KB"); nothing when it does not fit. */
function AttachmentHint({ images }: Readonly<{ images: readonly Attached[] }>) {
  const { columns } = useWindowSize();
  const line = attachmentSummary(images, Math.max(0, (columns ?? 80) - 2));
  return line ? <Text dimColor>{line}</Text> : null;
}

/** Text with its `[Image #N]` tokens drawn as cyan objects; `base` is the offset of `text` in the whole prompt. */
function Pieces({ text, base, spans }: Readonly<{ text: string; base: number; spans: readonly TokenSpan[] }>) {
  return (
    <>
      {segments(text, base, spans).map((seg) =>
        seg.token ? (
          <Text key={seg.at} color={tone('cyan')} bold>
            {displayToken(seg.text)}
          </Text>
        ) : (
          <Text key={seg.at}>{seg.text}</Text>
        ),
      )}
    </>
  );
}

function SlashMenu({ matches, selected }: Readonly<{ matches: readonly SlashCommand[]; selected: number }>) {
  const shown = matches.slice(0, 8);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {shown.map((c, i) => (
        <Text key={c.name} color={i === selected ? tone('cyan') : undefined} bold={i === selected}>
          {`${i === selected ? '›' : ' '} /${c.name.padEnd(12)}`}
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
  /** Offset of the line's first character in the whole text. */
  base: number;
}

interface CursorLineProps {
  line: EditorLine;
  col: number;
  spans: readonly TokenSpan[];
  active: boolean;
  placeholder: ReactNode;
}

/** The line with the cursor: a token at the cursor is highlighted whole, otherwise the one character under it. */
function CursorLine({ line, col, spans, active, placeholder }: Readonly<CursorLineProps>) {
  const onToken = spans.find((sp) => sp.start === line.base + col);
  const under = onToken ? line.text.slice(col, onToken.end - line.base) : line.text.slice(col, after(line.text, col)) || ' ';
  const restAt = col + under.length;
  return (
    <Text>
      <Pieces text={line.text.slice(0, col)} base={line.base} spans={spans} />
      <Text inverse={active}>{onToken ? <Pieces text={under} base={line.base + col} spans={spans} /> : under}</Text>
      <Pieces text={line.text.slice(restAt)} base={line.base + restAt} spans={spans} />
      {placeholder}
    </Text>
  );
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
  const spans = spansOf(state);
  let base = 0;
  const lines: EditorLine[] = state.text.split('\n').map((text, id) => {
    const line = { id, text, base };
    base += text.length + 1;
    return line;
  });
  const first = Math.max(0, Math.min(row - MAX_VISIBLE_LINES + 1, lines.length - MAX_VISIBLE_LINES));
  const visible = lines.slice(first, first + MAX_VISIBLE_LINES);
  const hint = state.text === '' ? <Text dimColor>{` ${placeholder}`}</Text> : null;
  return (
    <Box flexDirection="column">
      {first > 0 ? <Text dimColor>{`… ${first} line(s) above`}</Text> : null}
      {visible.map((line) => (
        <Box key={line.id}>
          <Text color={tone(glyphTone)} bold>{line.id === 0 ? `${glyph} ` : '  '}</Text>
          {line.id === row ? (
            <CursorLine line={line} col={col} spans={spans} active={active} placeholder={hint} />
          ) : (
            <Text>{line.text ? <Pieces text={line.text} base={line.base} spans={spans} /> : ' '}</Text>
          )}
        </Box>
      ))}
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
  /** Working folder: relative image paths are resolved against it. */
  cwd?: string;
  /** Reads an image from the OS clipboard (Ctrl+V, Alt+V, /paste-image); default: the real clipboard. */
  readClipboard?: ClipboardReader;
  /** Returns an error to show under the box (the text and the images are put back), or null when accepted. `text` keeps the `[Image #N]` tokens, renumbered to match `images` (in number order). */
  onSubmit(text: string, images: readonly ImageAttachment[]): Promise<string | null> | string | null;
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

/**
 * `showEntry` puts an entry into the box (an entry starting with ! re-enters shell mode). History entries
 * are plain text; the unsent draft comes back with its text and its attached images together.
 */
function useHistoryWalk(history: readonly string[], showEntry: (entry: EditorState) => void) {
  const index = useRef(-1);
  const draft = useRef<EditorState>(EMPTY_EDITOR);
  const reset = () => {
    index.current = -1;
  };
  const show = (at: number, entry: EditorState) => {
    index.current = at;
    showEntry(entry);
  };
  /** Older (-1) or newer (+1); returns false when there is nowhere to go. */
  const walk = (dir: -1 | 1, current: EditorState): boolean => {
    if (history.length === 0) return false;
    if (dir === -1) {
      if (index.current === 0) return true;
      if (index.current === -1) draft.current = current;
      const next = index.current === -1 ? history.length - 1 : index.current - 1;
      show(next, editorOf(history[next]));
      return true;
    }
    if (index.current === -1) return false;
    const next = index.current + 1;
    if (next >= history.length) show(-1, editorOf(draft.current.text, draft.current.images));
    else show(next, editorOf(history[next]));
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
  const showEntry = (entry: EditorState) => {
    const asShell = shellEnabled && entry.text.startsWith('!');
    putShell(asShell);
    putEditor(asShell ? editorOf(entry.text.slice(1), entry.images) : entry);
  };
  const walker = useHistoryWalk(history, showEntry);
  const { onDraft, onShellMode } = props;
  const imagesOn = !plain;
  const loader = useImageLoader(props.readClipboard ?? readClipboardImage);
  const [note, setNote] = useState<string | null>(null);
  const pathEnv = { cwd: props.cwd ?? process.cwd() };

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
    setNote(null);
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

  /** Puts a loaded image into the prompt as a token at the cursor (the box may have changed while it was read). */
  const showLoaded = (loaded: Loaded) => {
    if (loaded.kind === 'note') {
      setNote(loaded.note);
    } else if (loaded.kind === 'image') {
      const next = insertImage(latest.current, loaded.image);
      if (next) edit(next);
      else setNote(LIMIT_NOTE);
    }
  };

  const pasteImage = async () => {
    if (shellRef.current) {
      setNote(SHELL_IMAGE_NOTE);
    } else if ((latest.current.images?.length ?? 0) >= MAX_IMAGES) {
      setNote(LIMIT_NOTE);
    } else {
      showLoaded(await loader.readClipboard());
    }
  };

  /** The absolute path when `text` is a lone image path and the box takes images right now. */
  const imagePathOf = (text: string): string | undefined => (imagesOn && !shellRef.current ? pastedImagePath(text, pathEnv) : undefined);

  /** A pasted or dropped lone image path attaches the file; anything else is inserted as text. */
  const insertOrAttach = (text: string) => {
    const file = imagePathOf(text);
    if (!file) {
      accept(insertText(latest.current, text));
      return;
    }
    void loadPath(file).then((loaded) => {
      if (loaded.kind === 'text') accept(insertText(latest.current, text));
      else showLoaded(loaded);
    });
  };

  /** Enter on a lone image path typed by hand turns the path into a token instead of sending; true when it did (or refused it). */
  const attachTyped = async (file: string): Promise<boolean> => {
    const loaded = await loadPath(file);
    if (loaded.kind === 'text') return false;
    if (loaded.kind === 'image') {
      putEditor(insertImage(EMPTY_EDITOR, loaded.image) ?? EMPTY_EDITOR);
      setNote(null);
    } else {
      setNote(loaded.note);
    }
    return true;
  };

  /** /paste-image and /clear-images belong to the box, which owns the attachments. The line is already cleared. */
  const runLocal = (name: string, attachedCount: number) => {
    if (name === 'paste-image') {
      void pasteImage();
    } else {
      setNote(attachedCount > 0 ? 'Removed the attached images.' : 'No images attached.');
    }
  };

  const submit = async () => {
    const cur = latest.current;
    const text = cur.text.trim();
    if (!text) return;
    const bare = clearImages(cur).text.trim();
    const name = bare.startsWith('/') ? bare.slice(1).trim().toLowerCase() : '';
    if (imagesOn && LOCAL_COMMANDS.has(name)) {
      putEditor(EMPTY_EDITOR);
      runLocal(name, cur.images?.length ?? 0);
      return;
    }
    const file = cur.images?.length ? undefined : imagePathOf(text);
    if (file && (await attachTyped(file))) return;
    putEditor(EMPTY_EDITOR);
    walker.reset();
    const problem = await deliver(cur, text, bare);
    setError(problem);
    if (problem && !latest.current.text) putEditor(editorOf(text, cur.images));
  };

  /** Sends the prompt (tokens renumbered, images in number order), a slash command (without tokens) or a shell command. */
  const deliver = async (cur: EditorState, text: string, bare: string): Promise<string | null> => {
    if (shellRef.current && props.onShell) return props.onShell(text);
    if (bare.startsWith('/')) return props.onSubmit(bare, []);
    const sent = renumberForSend(text, cur.images ?? []);
    return props.onSubmit(sent.text, sent.images);
  };

  const runCommand = (command: SlashCommand) => {
    const count = latest.current.images?.length ?? 0;
    putEditor(EMPTY_EDITOR);
    if (imagesOn && LOCAL_COMMANDS.has(command.name)) runLocal(command.name, count);
    else props.onCommand?.(command);
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
    else walker.walk(step, latest.current);
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

  /** Ctrl+V / Alt+V and pasted-chunk image paths; true when consumed. */
  const imageKey = (input: string, key: Key): boolean => {
    if (!imagesOn) return false;
    const modified = key.ctrl || key.meta;
    if (modified && input === 'v') {
      void pasteImage();
      return true;
    }
    if (input.length > 1 && !modified && imagePathOf(input)) {
      insertOrAttach(input);
      return true;
    }
    return false;
  };

  useInput(
    (input, key) => {
      if (key.eventType === 'release' || (key.ctrl && input === 'c')) return;
      if (props.reserveScrollKeys && isScrollKey(key)) return;
      if (imageKey(input, key)) return;
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
  usePaste(insertOrAttach, { isActive: active });

  const borderColor = tone(shell ? 'magenta' : (props.borderTone ?? 'cyan'));
  return (
    <Box flexDirection="column">
      {plain ? null : <RoleChips roles={roles} role={role} plainLabel="role:" />}
      <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
        <EditorView state={editor} placeholder={shell ? 'command to run in the session folder' : placeholder} active={active} glyph={shell ? '!' : '›'} glyphTone={shell ? 'magenta' : 'cyan'} />
      </Box>
      {menuOpen ? <SlashMenu matches={matches} selected={selected} /> : null}
      {error ? <Text color={tone('red')}>{error}</Text> : null}
      {note ? <Text color={tone('yellow')}>{note}</Text> : null}
      {editor.images && !note && !error && !shell ? <AttachmentHint images={editor.images} /> : null}
      {shell ? <Text dimColor>{SHELL_HINT}</Text> : null}
      {!shell && lineCount(editor) > 1 ? <Text dimColor>Enter sends · Alt+Enter, Ctrl+J or trailing \ for a new line</Text> : null}
    </Box>
  );
}
