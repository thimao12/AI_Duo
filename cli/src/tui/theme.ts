import type { Speaker } from '../../../server/src/types.ts';

export type Tone = 'cyan' | 'green' | 'yellow' | 'red' | 'magenta' | 'blue' | 'gray';

/** A colour, or undefined when NO_COLOR asks for plain text. Read at render time. */
export const tone = (name: Tone): Tone | undefined => (process.env.NO_COLOR ? undefined : name);

const SPEAKER_TONE: Record<Speaker, Tone> = { claude: 'yellow', codex: 'green', user: 'magenta', system: 'cyan' };
export const speakerTone = (speaker: Speaker): Tone | undefined => tone(SPEAKER_TONE[speaker]);

export const SPEAKER_NAME: Record<Speaker, string> = { claude: 'Claude', codex: 'Codex', system: 'AI Duo', user: 'You' };

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Terminal width to lay out for; never below a usable minimum. */
export const usableWidth = (columns: number | undefined): number => Math.max(40, columns ?? 80);
