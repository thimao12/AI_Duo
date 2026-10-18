import { Box, Text } from 'ink';
import { activeTheme } from './theme.ts';
import { gradientAt } from './themes.ts';

/**
 * Duo mark: two overlapping discs, one flowing gradient left to right through the theme's accent
 * and info colours. Light falls from above (the top is lifted, the bottom deepened) and the
 * lens the discs share is lit up, so the two circles still read as a pair. Each terminal row carries
 * two pixel rows through the half blocks ▀ ▄ █, so the pixels come out square and the discs round.
 */
const HEIGHT = 12;
const WIDTH = 20;
const RADIUS = 5.9;
const CENTERS = [6, 14];
const MIDDLE = HEIGHT / 2;

export const LOGO_ROWS = HEIGHT / 2;
export const LOGO_WIDTH = WIDTH;

const HEX = /^#[0-9a-f]{6}$/i;

/** Blend `color` towards `target`; named (non-hex) colours can't be mixed and stay as they are. */
function toward(color: string, target: string, amount: number): string {
  return HEX.test(color) ? gradientAt([color, target], amount) : color;
}

/** The colour of pixel (x, y), or undefined for an empty pixel. */
export function logoPixel(x: number, y: number, stops: readonly string[]): string | undefined {
  const inside = CENTERS.map((cx) => Math.hypot(x + 0.5 - cx, y + 0.5 - MIDDLE) <= RADIUS);
  if (!inside[0] && !inside[1]) return undefined;
  const base = gradientAt(stops, (x + 0.5) / WIDTH);
  const down = y / (HEIGHT - 1);
  const lit = toward(toward(base, '#ffffff', 0.28 * (1 - down)), '#000000', 0.22 * down);
  if (inside[0] && inside[1]) return HEX.test(base) ? toward(base, '#ffffff', 0.4 - 0.15 * down) : 'white';
  return lit;
}

interface Cell {
  char: string;
  color?: string;
  bg?: string;
}

/** One terminal row (two pixel rows) as cells. */
export function logoRow(row: number, stops: readonly string[]): Cell[] {
  const cells: Cell[] = [];
  for (let x = 0; x < WIDTH; x++) {
    const up = logoPixel(x, row * 2, stops);
    const low = logoPixel(x, row * 2 + 1, stops);
    if (up && low) cells.push(up === low ? { char: '█', color: up } : { char: '▀', color: up, bg: low });
    else if (up) cells.push({ char: '▀', color: up });
    else if (low) cells.push({ char: '▄', color: low });
    else cells.push({ char: ' ' });
  }
  return cells;
}

/** Consecutive cells with the same colours share one <Text>. */
function runs(cells: readonly Cell[]): Cell[] {
  const out: Cell[] = [];
  for (const cell of cells) {
    const last = out.at(-1);
    if (last && last.color === cell.color && last.bg === cell.bg) last.char += cell.char;
    else out.push({ ...cell });
  }
  return out;
}

/** Plain text stand-in for NO_COLOR terminals: the same shape without colour. */
export function plainLogoRow(row: number): string {
  return logoRow(row, ['#']).map((c) => c.char).join('');
}

export function Logo() {
  const { logo } = activeTheme();
  const plain = !!process.env.NO_COLOR;
  return (
    <Box flexDirection="column" flexShrink={0} width={WIDTH}>
      {Array.from({ length: LOGO_ROWS }, (_, row) => (
        <Text key={row}>
          {plain
            ? plainLogoRow(row)
            : runs(logoRow(row, logo)).map((cell, i) => (
                <Text key={i} color={cell.color} backgroundColor={cell.bg}>
                  {cell.char}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  );
}
