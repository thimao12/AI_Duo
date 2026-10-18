/** Colour themes. Each fills the seven roles the UI uses (named after the ANSI colours they replace). */

export type Tone = 'cyan' | 'green' | 'yellow' | 'red' | 'magenta' | 'blue' | 'gray';

export interface Theme {
  id: string;
  label: string;
  dark: boolean;
  /** cyan = accent, green = success, yellow = warning, red = error, magenta = you, blue = info, gray = muted. */
  colors: Record<Tone, string>;
  diff: { addBg: string; delBg: string; addFg: string; delFg: string; gutter: string };
  /** Logo gradients, top to bottom: the first letter A is warm, the second cool. */
  logo: { warm: [string, string]; cool: [string, string, string] };
}

const theme = (id: string, label: string, dark: boolean, colors: Theme['colors'], diff: Theme['diff'], logo: Theme['logo']): Theme => ({ id, label, dark, colors, diff, logo });

const diff = (addBg: string, delBg: string, addFg: string, delFg: string, gutter: string): Theme['diff'] => ({ addBg, delBg, addFg, delFg, gutter });

export const THEMES: readonly Theme[] = [
  theme('tokyo-night', 'Tokyo Night', true,
    { cyan: '#7dcfff', green: '#9ece6a', yellow: '#e0af68', red: '#f7768e', magenta: '#bb9af7', blue: '#7aa2f7', gray: '#565f89' },
    diff('#20361f', '#3b2030', '#9ece6a', '#f7768e', '#565f89'),
    { warm: ['#e0af68', '#f7768e'], cool: ['#9ece6a', '#7aa2f7', '#bb9af7'] }),
  theme('dracula', 'Dracula', true,
    { cyan: '#8be9fd', green: '#50fa7b', yellow: '#f1fa8c', red: '#ff5555', magenta: '#ff79c6', blue: '#bd93f9', gray: '#6272a4' },
    diff('#1f3d2b', '#4a2330', '#50fa7b', '#ff5555', '#6272a4'),
    { warm: ['#ffb86c', '#ff5555'], cool: ['#50fa7b', '#8be9fd', '#bd93f9'] }),
  theme('catppuccin-mocha', 'Catppuccin Mocha', true,
    { cyan: '#94e2d5', green: '#a6e3a1', yellow: '#f9e2af', red: '#f38ba8', magenta: '#cba6f7', blue: '#89b4fa', gray: '#6c7086' },
    diff('#26382d', '#3d2433', '#a6e3a1', '#f38ba8', '#6c7086'),
    { warm: ['#fab387', '#f38ba8'], cool: ['#a6e3a1', '#89b4fa', '#cba6f7'] }),
  theme('rose-pine', 'Rosé Pine', true,
    { cyan: '#9ccfd8', green: '#7fc8a9', yellow: '#f6c177', red: '#eb6f92', magenta: '#c4a7e7', blue: '#31748f', gray: '#6e6a86' },
    diff('#1f3a32', '#40232f', '#7fc8a9', '#eb6f92', '#6e6a86'),
    { warm: ['#f6c177', '#eb6f92'], cool: ['#9ccfd8', '#31748f', '#c4a7e7'] }),
  theme('nord', 'Nord', true,
    { cyan: '#88c0d0', green: '#a3be8c', yellow: '#ebcb8b', red: '#bf616a', magenta: '#b48ead', blue: '#81a1c1', gray: '#616e88' },
    diff('#2c3b2f', '#43292f', '#a3be8c', '#bf616a', '#616e88'),
    { warm: ['#ebcb8b', '#bf616a'], cool: ['#a3be8c', '#81a1c1', '#b48ead'] }),
  theme('gruvbox-dark', 'Gruvbox Dark', true,
    { cyan: '#8ec07c', green: '#b8bb26', yellow: '#fabd2f', red: '#fb4934', magenta: '#d3869b', blue: '#83a598', gray: '#928374' },
    diff('#32361a', '#4a2320', '#b8bb26', '#fb4934', '#928374'),
    { warm: ['#fabd2f', '#fb4934'], cool: ['#b8bb26', '#83a598', '#d3869b'] }),
  theme('one-dark', 'One Dark', true,
    { cyan: '#56b6c2', green: '#98c379', yellow: '#e5c07b', red: '#e06c75', magenta: '#c678dd', blue: '#61afef', gray: '#5c6370' },
    diff('#263a29', '#40262b', '#98c379', '#e06c75', '#5c6370'),
    { warm: ['#e5c07b', '#e06c75'], cool: ['#98c379', '#61afef', '#c678dd'] }),
  theme('solarized-light', 'Solarized Light', false,
    { cyan: '#2aa198', green: '#859900', yellow: '#b58900', red: '#dc322f', magenta: '#d33682', blue: '#268bd2', gray: '#839496' },
    diff('#dcebc8', '#f6d5cf', '#586e75', '#586e75', '#93a1a1'),
    { warm: ['#b58900', '#dc322f'], cool: ['#859900', '#268bd2', '#6c71c4'] }),
];

/** The terminal's own 16 colours; used when the terminal has no truecolor. */
export const ANSI_THEME: Theme = {
  id: 'default',
  label: 'Terminal colours',
  dark: true,
  colors: { cyan: 'cyan', green: 'green', yellow: 'yellow', red: 'red', magenta: 'magenta', blue: 'blue', gray: 'gray' },
  diff: { addBg: 'green', delBg: 'red', addFg: 'green', delFg: 'red', gutter: 'gray' },
  logo: { warm: ['yellow', 'red'], cool: ['green', 'blue', 'magenta'] },
};

export const DEFAULT_THEME_ID = 'tokyo-night';

export const findTheme = (id: string | undefined): Theme | undefined => (id === ANSI_THEME.id ? ANSI_THEME : THEMES.find((t) => t.id === id));

/** Hex colours need truecolor; Windows Terminal, VS Code and most modern terminals announce it. */
export function supportsTrueColor(env: NodeJS.ProcessEnv = process.env): boolean {
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  return colorterm === 'truecolor' || colorterm === '24bit' || !!env.WT_SESSION || env.TERM_PROGRAM === 'vscode' || env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm' || /-direct$|truecolor/.test(env.TERM ?? '');
}

/** The colour at `t` (0..1) along a list of stops; hex stops are blended, named colours picked by position. */
export function gradientAt(stops: readonly string[], t: number): string {
  const clamped = Math.min(Math.max(t, 0), 1);
  if (stops.length === 1 || !stops.every((s) => /^#[0-9a-f]{6}$/i.test(s))) return stops[Math.min(stops.length - 1, Math.floor(clamped * stops.length))];
  const scaled = clamped * (stops.length - 1);
  const i = Math.min(Math.floor(scaled), stops.length - 2);
  const f = scaled - i;
  const channel = (hex: string, n: number) => Number.parseInt(hex.slice(1 + n * 2, 3 + n * 2), 16);
  const mix = (n: number) => Math.round(channel(stops[i], n) * (1 - f) + channel(stops[i + 1], n) * f);
  return `#${[0, 1, 2].map((n) => mix(n).toString(16).padStart(2, '0')).join('')}`;
}
