/** Colour themes. Each fills the seven roles the UI uses (named after the ANSI colours they replace). */

export type Tone = 'cyan' | 'green' | 'yellow' | 'red' | 'magenta' | 'blue' | 'gray';

export interface Theme {
  id: string;
  label: string;
  dark: boolean;
  /** cyan = accent, green = success, yellow = warning, red = error, magenta = you, blue = info, gray = muted. */
  colors: Record<Tone, string>;
  diff: { addBg: string; delBg: string; addFg: string; delFg: string; gutter: string };
  /** Logo gradient stops, left to right: the theme's calm accent and info colours, so the mark always matches the theme. */
  logo: string[];
}

const theme = (id: string, label: string, dark: boolean, colors: Theme['colors'], diff: Theme['diff']): Theme => ({ id, label, dark, colors, diff, logo: [colors.green, colors.cyan, colors.blue, colors.magenta, colors.red, colors.yellow] });

const diff = (addBg: string, delBg: string, addFg: string, delFg: string, gutter: string): Theme['diff'] => ({ addBg, delBg, addFg, delFg, gutter });

export const THEMES: readonly Theme[] = [
  theme('tokyo-night', 'Tokyo Night', true,
    { cyan: '#7dcfff', green: '#9ece6a', yellow: '#e0af68', red: '#f7768e', magenta: '#bb9af7', blue: '#7aa2f7', gray: '#565f89' },
    diff('#20361f', '#3b2030', '#9ece6a', '#f7768e', '#565f89')),
  theme('dracula', 'Dracula', true,
    { cyan: '#8be9fd', green: '#50fa7b', yellow: '#f1fa8c', red: '#ff5555', magenta: '#ff79c6', blue: '#bd93f9', gray: '#6272a4' },
    diff('#1f3d2b', '#4a2330', '#50fa7b', '#ff5555', '#6272a4')),
  theme('catppuccin-mocha', 'Catppuccin Mocha', true,
    { cyan: '#94e2d5', green: '#a6e3a1', yellow: '#f9e2af', red: '#f38ba8', magenta: '#cba6f7', blue: '#89b4fa', gray: '#6c7086' },
    diff('#26382d', '#3d2433', '#a6e3a1', '#f38ba8', '#6c7086')),
  theme('catppuccin-latte', 'Catppuccin Latte', false,
    { cyan: '#179299', green: '#40a02b', yellow: '#df8e1d', red: '#d20f39', magenta: '#8839ef', blue: '#1e66f5', gray: '#8c8fa1' },
    diff('#dcefd8', '#f8d9df', '#40a02b', '#d20f39', '#8c8fa1')),
  theme('rose-pine', 'Rosé Pine', true,
    { cyan: '#9ccfd8', green: '#7fc8a9', yellow: '#f6c177', red: '#eb6f92', magenta: '#c4a7e7', blue: '#31748f', gray: '#6e6a86' },
    diff('#1f3a32', '#40232f', '#7fc8a9', '#eb6f92', '#6e6a86')),
  theme('nord', 'Nord', true,
    { cyan: '#88c0d0', green: '#a3be8c', yellow: '#ebcb8b', red: '#bf616a', magenta: '#b48ead', blue: '#81a1c1', gray: '#616e88' },
    diff('#2c3b2f', '#43292f', '#a3be8c', '#bf616a', '#616e88')),
  theme('gruvbox-dark', 'Gruvbox Dark', true,
    { cyan: '#8ec07c', green: '#b8bb26', yellow: '#fabd2f', red: '#fb4934', magenta: '#d3869b', blue: '#83a598', gray: '#928374' },
    diff('#32361a', '#4a2320', '#b8bb26', '#fb4934', '#928374')),
  theme('one-dark', 'One Dark', true,
    { cyan: '#56b6c2', green: '#98c379', yellow: '#e5c07b', red: '#e06c75', magenta: '#c678dd', blue: '#61afef', gray: '#5c6370' },
    diff('#263a29', '#40262b', '#98c379', '#e06c75', '#5c6370')),
  theme('monokai', 'Monokai', true,
    { cyan: '#66d9ef', green: '#a6e22e', yellow: '#e6db74', red: '#f92672', magenta: '#ae81ff', blue: '#fd971f', gray: '#75715e' },
    diff('#273620', '#3e1b28', '#a6e22e', '#f92672', '#75715e')),
  theme('solarized-dark', 'Solarized Dark', true,
    { cyan: '#2aa198', green: '#859900', yellow: '#b58900', red: '#dc322f', magenta: '#d33682', blue: '#268bd2', gray: '#657b83' },
    diff('#1e392b', '#3e1e24', '#859900', '#dc322f', '#657b83')),
  theme('solarized-light', 'Solarized Light', false,
    { cyan: '#2aa198', green: '#859900', yellow: '#b58900', red: '#dc322f', magenta: '#d33682', blue: '#268bd2', gray: '#839496' },
    diff('#dcebc8', '#f6d5cf', '#586e75', '#586e75', '#93a1a1')),
  theme('github-dark', 'GitHub Dark', true,
    { cyan: '#58a6ff', green: '#3fb950', yellow: '#d29922', red: '#f85149', magenta: '#bc8cff', blue: '#79c0ff', gray: '#8b949e' },
    diff('#1a3826', '#441d24', '#3fb950', '#f85149', '#8b949e')),
  theme('github-light', 'GitHub Light', false,
    { cyan: '#0969da', green: '#1a7f37', yellow: '#9a6700', red: '#cf222e', magenta: '#8250df', blue: '#218bff', gray: '#6e7781' },
    diff('#dafbe1', '#ffebe9', '#1a7f37', '#cf222e', '#6e7781')),
  theme('monochrome-dark', 'Monochrome Dark', true,
    { cyan: '#e0e0e0', green: '#b0d0b0', yellow: '#dedeb0', red: '#d0a0a0', magenta: '#c0b0d0', blue: '#a0b8d0', gray: '#707070' },
    diff('#283028', '#382828', '#b0d0b0', '#d0a0a0', '#707070')),
  theme('monochrome-light', 'Monochrome Light', false,
    { cyan: '#222222', green: '#2e582e', yellow: '#685a20', red: '#8a2525', magenta: '#503570', blue: '#2b4e78', gray: '#767676' },
    diff('#e4ece4', '#ece4e4', '#2e582e', '#8a2525', '#767676')),
  theme('high-contrast-dark', 'High Contrast Dark', true,
    { cyan: '#00ffff', green: '#00ff00', yellow: '#ffff00', red: '#ff3333', magenta: '#ff00ff', blue: '#3399ff', gray: '#aaaaaa' },
    diff('#003300', '#440000', '#00ff00', '#ff3333', '#aaaaaa')),
  theme('high-contrast-light', 'High Contrast Light', false,
    { cyan: '#005577', green: '#006600', yellow: '#774400', red: '#aa0000', magenta: '#660066', blue: '#0022aa', gray: '#444444' },
    diff('#ccffcc', '#ffcccc', '#006600', '#aa0000', '#444444')),
  theme('night-owl', 'Night Owl', true,
    { cyan: '#7fdbca', green: '#22da6e', yellow: '#ecc48d', red: '#ef5350', magenta: '#c792ea', blue: '#82aaff', gray: '#5f7e97' },
    diff('#0c3d2f', '#3f1824', '#22da6e', '#ef5350', '#5f7e97')),
  theme('ayu-dark', 'Ayu Dark', true,
    { cyan: '#95e6cb', green: '#aad94c', yellow: '#ffb454', red: '#f07178', magenta: '#d4bfff', blue: '#59c2ff', gray: '#626a73' },
    diff('#1e361b', '#3b1c20', '#aad94c', '#f07178', '#626a73')),
  theme('synthwave-84', "Synthwave '84", true,
    { cyan: '#36f9f6', green: '#72f1b8', yellow: '#fede5d', red: '#fe4450', magenta: '#ff7edb', blue: '#2de2e6', gray: '#8468b4' },
    diff('#263d36', '#421f2f', '#72f1b8', '#fe4450', '#8468b4')),
];

/** The terminal's own 16 colours; used when the terminal has no truecolor. */
export const ANSI_THEME: Theme = {
  id: 'default',
  label: 'Terminal colours',
  dark: true,
  colors: { cyan: 'cyan', green: 'green', yellow: 'yellow', red: 'red', magenta: 'magenta', blue: 'blue', gray: 'gray' },
  diff: { addBg: 'green', delBg: 'red', addFg: 'green', delFg: 'red', gutter: 'gray' },
  logo: ['green', 'cyan', 'blue', 'magenta', 'red', 'yellow'],
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
