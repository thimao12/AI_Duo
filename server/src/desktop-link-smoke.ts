import assert from 'node:assert/strict';
import { openAgentLink } from '../../desktop/link-handler.mjs';

const appUrl = 'http://localhost:47821';
const actions: Array<[string, string]> = [];
const directories = new Set(['C:/workspace/folder.js']);
const statted: string[] = [];

function route(path: string) {
  openAgentLink(`${appUrl}/${path}`, appUrl, {
    statSync(target) {
      statted.push(target);
      if (target === 'C:/missing.txt') throw new Error('not found');
      return { isDirectory: () => directories.has(target) };
    },
    shell: {
      openExternal: (target) => actions.push(['external', target]),
      openPath: (target) => actions.push(['open', target]),
      showItemInFolder: (target) => actions.push(['select', target]),
    },
  });
}

for (const extension of ['md', 'txt', 'log', 'json', 'diff', 'patch', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'pdf']) {
  actions.length = 0;
  route(`C:/workspace/file.${extension}`);
  assert.deepEqual(actions, [['open', `C:/workspace/file.${extension}`]], `.${extension} should open directly`);
}

for (const extension of ['exe', 'bat', 'ps1', 'js', 'ts', 'py', 'cmd', 'lnk', 'vbs', 'hta', 'msi']) {
  actions.length = 0;
  route(`C:/Windows/System32/file.${extension}`);
  assert.deepEqual(actions, [['select', `C:/Windows/System32/file.${extension}`]], `.${extension} should only be selected in Explorer`);
}

actions.length = 0;
route('C:/workspace/folder.js');
assert.deepEqual(actions, [['open', 'C:/workspace/folder.js']], 'directories should open even when their names have a blocked extension');

actions.length = 0;
route('C:/missing.txt');
assert.deepEqual(actions, [], 'missing paths should be ignored');

assert.doesNotThrow(() => route('C:/workspace/%E0%A4%A'));
assert.deepEqual(actions, [], 'malformed percent encoding should be ignored');

for (const unc of ['/server/share/notes.md', '%5C%5Cserver%5Cshare%5Cnotes.md', '%5Cserver/share/notes.md', '/?/C:/workspace/file.md']) {
  actions.length = 0;
  statted.length = 0;
  route(unc);
  assert.deepEqual(actions, [], `UNC/device path ${unc} should be ignored`);
  assert.deepEqual(statted, [], `UNC/device path ${unc} must not be stat()ed (would contact the remote host)`);
}

actions.length = 0;
route('C:/workspace/run.bat:x.md');
assert.deepEqual(actions, [], 'NTFS alternate data streams should be ignored');

console.log('Desktop link routing smoke checks passed.');
