const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, d) => cb(d)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, d) => cb(d)),
  ready: () => ipcRenderer.send('ready'),
  drag: (dx, dy) => ipcRenderer.send('drag', dx, dy),
  dragEnd: () => ipcRenderer.send('drag-end'),
  setIgnore: (v) => ipcRenderer.send('set-ignore', !!v),
  menu: () => ipcRenderer.send('menu'),
  openApp: (id) => ipcRenderer.send('open-app', typeof id === 'string' ? id : ''),
});
