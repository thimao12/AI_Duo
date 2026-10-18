import { Box, Text } from 'ink';
import { activeTheme } from './theme.ts';
import { gradientAt } from './themes.ts';

/**
 * Pixel-art logo: two "A" letters (the two agents) side by side and overlapping. Each terminal row
 * carries two pixel rows through the half blocks ▀ ▄ █, so the pixels come out square.
 * The first A takes the theme's warm gradient, the second (drawn over it) the cool one; `X` marks a pixel.
 */
const FIRST_A = [
  '....XXX....',
  '....XXX....',
  '...XX.XX...',
  '...XX.XX...',
  '..XX...XX..',
  '..XX...XX..',
  '.XXXXXXXXX.',
  '.XXXXXXXXX.',
  'XX.......XX',
  'XX.......XX',
  'XX.......XX',
  'XX.......XX',
];
const OFFSET = 6;
const HEIGHT = FIRST_A.length;
const WIDTH = FIRST_A[0].length + OFFSET;

export const LOGO_ROWS = HEIGHT / 2;
export const LOGO_WIDTH = WIDTH;

/** The colour of pixel (x, y), or undefined for an empty pixel. */
export function logoPixel(x: number, y: number, warm: readonly string[], cool: readonly string[]): string | undefined {
  const t = y / (HEIGHT - 1);
  if (FIRST_A[y]?.[x - OFFSET] === 'X') return gradientAt(cool, t);
  if (FIRST_A[y]?.[x] === 'X') return gradientAt(warm, t);
  return undefined;
}

interface Cell {
  char: string;
  color?: string;
  bg?: string;
}

/** One terminal row (two pixel rows) as cells. */
export function logoRow(row: number, warm: readonly string[], cool: readonly string[]): Cell[] {
  const cells: Cell[] = [];
  for (let x = 0; x < WIDTH; x++) {
    const up = logoPixel(x, row * 2, warm, cool);
    const low = logoPixel(x, row * 2 + 1, warm, cool);
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

/** Plain text stand-in for NO_COLOR terminals: the same shape in full blocks. */
export function plainLogoRow(row: number): string {
  return logoRow(row, ['#'], ['#']).map((c) => (c.char === ' ' ? ' ' : c.char === '▄' ? '▄' : c.char === '▀' ? '▀' : '█')).join('');
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
            : runs(logoRow(row, logo.warm, logo.cool)).map((cell, i) => (
                <Text key={i} color={cell.color} backgroundColor={cell.bg}>
                  {cell.char}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  );
}
