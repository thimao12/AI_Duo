import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { openAgentLink } from './link-handler.mjs';

const here = import.meta.dirname;
const dist = path.join(here, 'dist');
// Fixed port keeps the page origin stable, so the UI's saved form settings survive restarts.
const PREFERRED_PORT = 47821;
// The page's own 48px headers act as the title bar; the overlay stops 1px short so their bottom border shows.
const TITLE_BAR_HEIGHT = 47;
// First-paint colours (the --bg / --muted tokens); the page re-sends its resolved theme once it loads.
const themeColors = () =>
  nativeTheme.shouldUseDarkColors ? { color: '#17171a', symbolColor: '#a8a8b2' } : { color: '#ffffff', symbolColor: '#55555d' };

let win = null;
let server = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(start).catch((err) => {
    dialog.showErrorBox('AI Duo failed to start', String(err?.stack || err));
    app.quit();
  });
}

/**
 * Prompt templates are copied to the user-data folder once, so they stay editable
 * even when the app itself is packaged read-only.
 */
async function seedPrompts(target) {
  await mkdir(target, { recursive: true });
  for (const name of await readdir(path.join(dist, 'prompts'))) {
    const to = path.join(target, name);
    if (!existsSync(to)) await copyFile(path.join(dist, 'prompts', name), to);
  }
}

async function start() {
  const userData = app.getPath('userData');
  process.env.AI_DUO_DATA_DIR ||= path.join(userData, 'runs');
  process.env.AI_DUO_PROMPTS_DIR ||= path.join(userData, 'prompts');
  process.env.AI_DUO_WEB_DIST ||= path.join(dist, 'web');
  process.env.AI_DUO_DEFAULT_CWD ||= app.getPath('home');
  await seedPrompts(process.env.AI_DUO_PROMPTS_DIR);

  // The server reads the env vars above at import time, so import it only now.
  server = await import(pathToFileURL(path.join(dist, 'server.mjs')).href);
  const { url } = await server.startServer({ port: PREFERRED_PORT, fallbackPort: true });

  ipcMain.handle('pick-folder', async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Chọn thư mục làm việc',
      properties: ['openDirectory'],
      defaultPath: typeof defaultPath === 'string' && existsSync(defaultPath) ? defaultPath : undefined,
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.on('title-bar-colors', (_e, colors) => {
    // The CSS minifier shortens tokens (#ffffff → #fff), so accept both hex forms.
    const hex = (v) => (typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? (v.length === 4 ? `#${[...v.slice(1)].map((c) => c + c).join('')}` : v) : null);
    const color = hex(colors?.color);
    const symbolColor = hex(colors?.symbolColor);
    if (!win || !color || !symbolColor) return;
    win.setTitleBarOverlay({ color, symbolColor, height: TITLE_BAR_HEIGHT });
    win.setBackgroundColor(color);
  });

  createWindow(url);
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 720,
    minHeight: 480,
    title: 'AI Duo',
    backgroundColor: themeColors().color,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...themeColors(), height: TITLE_BAR_HEIGHT },
    show: false,
    icon: path.join(here, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openAgentLink(target, url, { statSync, shell });
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    // Only in-page (hash) routing is allowed inside the window.
    e.preventDefault();
    openAgentLink(target, url, { statSync, shell });
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => (win = null));
  win.loadURL(url);
}

app.on('window-all-closed', () => app.quit());
let stopping = false;
app.on('before-quit', (e) => {
  // Don't leave claude/codex processes running after the window is gone. Wait (briefly) until each
  // run is saved and has released its repository lock, which the CLI and dev server share.
  if (!server || stopping) return;
  stopping = true;
  e.preventDefault();
  const timeout = new Promise((resolve) => setTimeout(resolve, 8000));
  Promise.race([server.abortAll(), timeout]).finally(() => app.quit());
});
