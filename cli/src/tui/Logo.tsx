import { Box, Text } from 'ink';
import { activeTheme } from './theme.ts';
import { gradientAt } from './themes.ts';

/**
 * Line-art logo: two "A" letters (the two agents) drawn with diagonal strokes ╱ ╲ and crossbars ─.
 * Their inner legs cross into an X, so the pair reads as one woven mark. The first A takes the theme's
 * warm gradient, the second (drawn over it) the cool one, both top to bottom.
 */
export const LOGO_ROWS = 6;
const SHIFT = 6;
const APEX = LOGO_ROWS;
export const LOGO_WIDTH = APEX * 2 + SHIFT;

interface Cell {
  char: string;
  color?: string;
  bg?: string;
}

/** The glyph one A puts on (row, col), given the column of its apex. */
function stroke(row: number, col: number, apex: number): string | undefined {
  const left = apex - 1 - row;
  const right = apex + row;
  if (col === left) return '╱';
  if (col === right) return '╲';
  if (row === LOGO_ROWS - 2 && col > left && col < right) return '─';
  return undefined;
}

/** One terminal row as cells; the second A is drawn over the first. */
export function logoRow(row: number, warm: readonly string[], cool: readonly string[]): Cell[] {
  const t = row / (LOGO_ROWS - 1);
  const first = gradientAt(warm, t);
  const second = gradientAt(cool, t);
  const cells: Cell[] = [];
  for (let col = 0; col < LOGO_WIDTH; col++) {
    const b = stroke(row, col, APEX + SHIFT);
    const a = stroke(row, col, APEX);
    if (b && !(b === '─' && a && a !== '─')) cells.push({ char: b, color: second });
    else if (a) cells.push({ char: a, color: first });
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

/** Plain text stand-in for NO_COLOR terminals: the same strokes without colour. */
export function plainLogoRow(row: number): string {
  return logoRow(row, ['#'], ['#']).map((c) => c.char).join('');
}

export function Logo() {
  const { logo } = activeTheme();
  const plain = !!process.env.NO_COLOR;
  return (
    <Box flexDirection="column" flexShrink={0} width={LOGO_WIDTH}>
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
