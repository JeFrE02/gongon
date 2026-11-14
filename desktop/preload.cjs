// Minimal, read-only bridge. No ipcRenderer, no Node APIs, nothing writable.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('gongonDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  version: process.versions.electron,
}));
