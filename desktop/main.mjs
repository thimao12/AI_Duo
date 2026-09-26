import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

const here = import.meta.dirname;
const dist = path.join(here, 'dist');
// Fixed port keeps the page origin stable, so the UI's saved form settings survive restarts.
const PREFERRED_PORT = 47821;

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

  createWindow(url);
}

/** Links in agent output: web links go to the default browser, file paths open in Explorer/the editor. */
function openLink(raw, appUrl) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return;
  }
  if (u.origin !== new URL(appUrl).origin) {
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') shell.openExternal(u.href);
    return;
  }
  // Codex links files like /C:/Users/…/price.js
  let p = decodeURIComponent(u.pathname);
  if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  if (existsSync(p)) shell.openPath(p);
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 720,
    minHeight: 480,
    title: 'AI Duo',
    backgroundColor: '#09090b',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(here, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openLink(target, url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    // Only in-page (hash) routing is allowed inside the window.
    e.preventDefault();
    openLink(target, url);
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => (win = null));
  win.loadURL(url);
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  // Don't leave claude/codex processes running after the window is gone.
  server?.abortAll();
});
