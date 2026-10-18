import type { Speaker } from '../../../server/src/types.ts';
import { ANSI_THEME, DEFAULT_THEME_ID, findTheme, supportsTrueColor, type Theme, type Tone } from './themes.ts';

export type { Tone };

let active: Theme = supportsTrueColor() ? (findTheme(process.env.AI_DUO_THEME) ?? findTheme(DEFAULT_THEME_ID) ?? ANSI_THEME) : ANSI_THEME;

/** The theme colours are drawn in. Without truecolor only the terminal's own colours are used. */
export const activeTheme = (): Theme => active;

/** Switches the theme; false when the id is unknown. Callers re-render (App keys its layout on the id). */
export function setTheme(id: string): boolean {
  const found = findTheme(id);
  if (!found) return false;
  active = supportsTrueColor() ? found : ANSI_THEME;
  return true;
}

/** A colour of the active theme, or undefined when NO_COLOR asks for plain text. Read at render time. */
export const tone = (name: Tone): string | undefined => (process.env.NO_COLOR ? undefined : active.colors[name]);

const SPEAKER_TONE: Record<Speaker, Tone> = { claude: 'yellow', codex: 'green', antigravity: 'blue', user: 'magenta', system: 'cyan' };
export const speakerTone = (speaker: Speaker): string | undefined => tone(SPEAKER_TONE[speaker]);

export const SPEAKER_NAME: Record<Speaker, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', system: 'AI Duo', user: 'You' };

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Terminal width to lay out for; never below a usable minimum. */
export const usableWidth = (columns: number | undefined): number => Math.max(40, columns ?? 80);
