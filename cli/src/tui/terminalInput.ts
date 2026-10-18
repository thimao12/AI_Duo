import { EventEmitter } from 'node:events';

/**
 * Terminal input for the full-screen chat: one reader over the real stdin that takes mouse reports
 * (and the reply to the alternate-scroll query) out before Ink sees the rest.
 *
 * Why: in the alternate screen, Windows Terminal and VS Code turn the mouse wheel into Up/Down
 * arrow keys (alternate scroll). Those are indistinguishable from real arrows, so the composer
 * recalled prompt history on every wheel turn. With mouse reporting on, the wheel arrives as a
 * report instead; the report scrolls the thread and never reaches the composer or a panel.
 * Alternate scroll itself is switched off too, for terminals where mouse reporting is turned off
 * (AI_DUO_MOUSE=0) or not supported.
 */

export type WheelDirection = 'up' | 'down';

export interface WheelSource {
  /** Subscribes to wheel turns; returns the unsubscribe function. */
  onWheel(listener: (direction: WheelDirection) => void): () => void;
}

// DECSET 1000 (button events) + 1006 (SGR coordinates): the wheel is reported as CSI < 64/65 ; x ; y M.
export const MOUSE_ON = '\u001B[?1000h\u001B[?1006h';
export const MOUSE_OFF = '\u001B[?1006l\u001B[?1000l';
// Alternate scroll (1007): XTSAVE, then a DECRQM query of the current value, then off.
export const ALT_SCROLL_OFF = '\u001B[?1007s\u001B[?1007$p\u001B[?1007l';
export const ALT_SCROLL_RESTORE = '\u001B[?1007r';

const PASTE_START = '\u001B[200~';
const PASTE_END = '\u001B[201~';
const SGR_MOUSE = /\u001B\[<(\d+);(\d+);(\d+)([Mm])/y;
const X10_MOUSE = /\u001B\[M([\s\S])[\s\S][\s\S]/y;
const ALT_SCROLL_REPLY = /\u001B\[\?1007;(\d+)\$y/y;
/** The start of a sequence this reader owns, cut off at the end of a chunk. */
const PARTIAL = /^\u001B(?:\[(?:<[\d;]*|\?[\d;]*\$?|M[\s\S]{0,2}|2(?:0(?:0)?)?)?)?$/;

/** Holds back a cut-off sequence this long before passing it on as typed input (a lone Escape). */
export const PARTIAL_FLUSH_MS = 25;

export interface SplitResult {
  /** Everything that is not a mouse report or a mode reply, in order. */
  keys: string;
  wheel: WheelDirection[];
  /** DECRQM answer for alternate scroll: true = set, false = reset; absent when none arrived. */
  altScroll?: boolean;
}

/** Wheel direction of a button code (shift/alt/ctrl bits ignored), or undefined for clicks and motion. */
function wheelOf(code: number): WheelDirection | undefined {
  if ((code & 64) === 0 || (code & 32) !== 0) return undefined;
  if ((code & 3) === 0) return 'up';
  if ((code & 3) === 1) return 'down';
  return undefined;
}

/** Pure splitter: feed chunks in order; reports split across chunks are kept until complete. */
export class InputSplitter {
  private pending = '';
  private inPaste = false;

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  push(chunk: string): SplitResult {
    const s = this.pending + chunk;
    this.pending = '';
    const result: SplitResult = { keys: '', wheel: [] };
    let i = 0;
    while (i < s.length) {
      if (this.inPaste) {
        i = this.pasted(s, i, result);
        continue;
      }
      const esc = s.indexOf('\u001B', i);
      if (esc < 0) {
        result.keys += s.slice(i);
        break;
      }
      result.keys += s.slice(i, esc);
      i = this.sequence(s, esc, result);
    }
    return result;
  }

  /** What is still held back, as typed input (the timer ran out: it was a key, not a report). */
  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return rest;
  }

  /** Inside a bracketed paste nothing is parsed: the text goes to Ink as it is, up to the end marker. */
  private pasted(s: string, i: number, result: SplitResult): number {
    const end = s.indexOf(PASTE_END, i);
    if (end >= 0) {
      result.keys += s.slice(i, end + PASTE_END.length);
      this.inPaste = false;
      return end + PASTE_END.length;
    }
    let keep = 0;
    for (let k = PASTE_END.length - 1; k > 0; k--) {
      if (s.endsWith(PASTE_END.slice(0, k))) {
        keep = k;
        break;
      }
    }
    result.keys += s.slice(i, s.length - keep);
    this.pending = s.slice(s.length - keep);
    return s.length;
  }

  /** Handles the sequence starting at the Escape at `at`; returns where to continue. */
  private sequence(s: string, at: number, result: SplitResult): number {
    if (s.startsWith(PASTE_START, at)) {
      this.inPaste = true;
      result.keys += PASTE_START;
      return at + PASTE_START.length;
    }
    SGR_MOUSE.lastIndex = at;
    const sgr = SGR_MOUSE.exec(s);
    if (sgr) {
      const wheel = sgr[4] === 'M' ? wheelOf(Number(sgr[1])) : undefined;
      if (wheel) result.wheel.push(wheel);
      return SGR_MOUSE.lastIndex;
    }
    ALT_SCROLL_REPLY.lastIndex = at;
    const reply = ALT_SCROLL_REPLY.exec(s);
    if (reply) {
      const value = Number(reply[1]);
      if (value === 1 || value === 3) result.altScroll = true;
      else if (value === 2 || value === 4) result.altScroll = false;
      return ALT_SCROLL_REPLY.lastIndex;
    }
    X10_MOUSE.lastIndex = at;
    const x10 = X10_MOUSE.exec(s);
    if (x10) {
      const wheel = wheelOf(x10[1].codePointAt(0)! - 32);
      if (wheel) result.wheel.push(wheel);
      return X10_MOUSE.lastIndex;
    }
    if (PARTIAL.test(s.slice(at))) {
      this.pending = s.slice(at);
      return s.length;
    }
    // Any other sequence (arrows, function keys, Alt+key) is Ink's to parse.
    result.keys += '\u001B';
    return at + 1;
  }
}

type Source = Pick<NodeJS.ReadStream, 'on' | 'off' | 'setEncoding'> & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  ref?: () => unknown;
  unref?: () => unknown;
  pause?: () => unknown;
  resume?: () => unknown;
};

/**
 * The stdin handed to Ink: a readable-like facade (`read()`, 'readable', 'data', raw mode, ref) fed
 * by the one 'data' listener on the real stdin. Wheel turns go to `onWheel` subscribers.
 */
export class TerminalInput extends EventEmitter implements WheelSource {
  readonly isTTY: boolean;
  private readonly splitter = new InputSplitter();
  private queue = '';
  private flushTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private wheelListeners = new Set<(direction: WheelDirection) => void>();
  /** Alternate scroll as the terminal reported it before it was switched off; undefined = never answered. */
  altScroll: boolean | undefined;

  constructor(private readonly source: Source) {
    super();
    this.isTTY = Boolean(source.isTTY);
    source.setEncoding('utf8');
    source.on('data', this.onData);
  }

  onWheel(listener: (direction: WheelDirection) => void): () => void {
    this.wheelListeners.add(listener);
    return () => this.wheelListeners.delete(listener);
  }

  // Ink's side of the stream.
  read(): string | null {
    if (!this.queue) return null;
    const data = this.queue;
    this.queue = '';
    return data;
  }

  unshift(chunk: string | Uint8Array): void {
    this.queue = (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')) + this.queue;
  }

  setEncoding(): this {
    return this;
  }

  setRawMode(mode: boolean): this {
    this.source.setRawMode?.(mode);
    return this;
  }

  ref(): this {
    this.source.ref?.();
    return this;
  }

  unref(): this {
    this.source.unref?.();
    return this;
  }

  pause(): this {
    this.source.pause?.();
    return this;
  }

  resume(): this {
    this.source.resume?.();
    return this;
  }

  /** Stops reading the real stdin; safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.flushTimer);
    this.source.off('data', this.onData);
    this.wheelListeners.clear();
    // No pause() here: pausing the real stdin right before the process exits closed the whole terminal tab on Windows.
  }

  private readonly onData = (data: string | Buffer) => {
    clearTimeout(this.flushTimer);
    const split = this.splitter.push(typeof data === 'string' ? data : data.toString('utf8'));
    if (split.altScroll !== undefined) this.altScroll = split.altScroll;
    for (const direction of split.wheel) for (const listener of this.wheelListeners) listener(direction);
    this.deliver(split.keys);
    if (this.splitter.hasPending) {
      this.flushTimer = setTimeout(() => this.deliver(this.splitter.flush()), PARTIAL_FLUSH_MS);
      this.flushTimer.unref?.();
    }
  };

  private deliver(keys: string) {
    if (!keys || this.disposed) return;
    this.queue += keys;
    this.emit('readable');
    this.emit('data', keys);
  }
}

/** Mouse reporting is on unless AI_DUO_MOUSE=0 (then the wheel does nothing, and text selection needs no Shift). */
export const mouseEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|false|off|no)$/i.test(env.AI_DUO_MOUSE ?? '');

/** What the full-screen chat writes after entering the alternate screen. */
export const enterModes = (mouse: boolean): string => ALT_SCROLL_OFF + (mouse ? MOUSE_ON : '');

/**
 * What it writes before leaving: mouse off, then alternate scroll back. XTRESTORE covers terminals
 * that support it; the DECRQM answer covers the rest. A terminal that supports neither keeps it off
 * (only the alternate screen of later programs is affected).
 */
export const leaveModes = (mouse: boolean, altScroll: boolean | undefined): string =>
  (mouse ? MOUSE_OFF : '') + ALT_SCROLL_RESTORE + (altScroll === undefined ? '' : `\u001B[?1007${altScroll ? 'h' : 'l'}`);
