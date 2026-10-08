const { contextBridge, ipcRenderer } = require('electron');

function listen(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld('pixelDesktop', Object.freeze({
  isDetailWindow: process.argv.includes('--pixel-window=detail'),
  openDetails: launch => ipcRenderer.invoke('pixel:details-open', launch),
  onDetailsClosed: callback => listen('pixel:details-closed', callback),
  minimize: () => ipcRenderer.invoke('pixel:window-control', 'minimize'),
  toggleMaximize: () => ipcRenderer.invoke('pixel:window-control', 'maximize'),
  close: () => ipcRenderer.invoke('pixel:window-control', 'close'),
  isMaximized: () => ipcRenderer.invoke('pixel:window-maximized'),
  onMaximizedChanged: callback => listen('pixel:maximized', callback),
  prepareExport: request => ipcRenderer.invoke('pixel:export-prepare', request),
  startExport: ticket => ipcRenderer.send('pixel:export-start', ticket),
}));
