import path from 'node:path';

const VIEWABLE_FILE_EXTENSIONS = new Set([
  '.md', '.txt', '.log', '.json', '.diff', '.patch', '.csv',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf',
]);

/** Route links from agent output without launching arbitrary local files. */
export function openAgentLink(raw, appUrl, { statSync, shell }) {
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
  let p;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    return;
  }
  if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  // UNC / device paths (\\server\share, //?/…): even stat() would contact the remote host and can leak NTLM credentials.
  if (/^[\\/]{2}/.test(p)) return;
  // A ':' after the drive letter is an NTFS alternate data stream (run.bat:x.md) that would fool the extension check.
  if (p.includes(':', 2)) return;

  let stats;
  try {
    stats = statSync(p);
  } catch {
    return;
  }
  if (stats.isDirectory() || VIEWABLE_FILE_EXTENSIONS.has(path.extname(p).toLowerCase())) {
    shell.openPath(p);
  } else {
    shell.showItemInFolder(p);
  }
}
