// Sandboxed preload: only a tiny, explicit bridge is exposed to the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiDuo', {
  desktop: true,
  pickFolder: (defaultPath) => ipcRenderer.invoke('pick-folder', defaultPath),
});
