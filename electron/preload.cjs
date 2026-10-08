const { contextBridge, ipcRenderer } = require('electron');

function listen(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld('pixelDesktop', Object.freeze({
  isDetailWindow: process.argv.includes('--pixel-window=detail'),
  isLibraryWindow: process.argv.includes('--pixel-window=library'),
  openDetails: launch => ipcRenderer.invoke('pixel:details-open', launch),
  onDetailsClosed: callback => listen('pixel:details-closed', callback),
  openLibrary: () => ipcRenderer.invoke('pixel:library-open'),
  onLibraryClosed: callback => listen('pixel:library-closed', callback),
  minimize: () => ipcRenderer.invoke('pixel:window-control', 'minimize'),
  toggleMaximize: () => ipcRenderer.invoke('pixel:window-control', 'maximize'),
  close: () => ipcRenderer.invoke('pixel:window-control', 'close'),
  isMaximized: () => ipcRenderer.invoke('pixel:window-maximized'),
  onMaximizedChanged: callback => listen('pixel:maximized', callback),
  prepareExport: request => ipcRenderer.invoke('pixel:export-prepare', request),
  startExport: ticket => ipcRenderer.send('pixel:export-start', ticket),
  beginObjectDrag: (source, offsetTicks) => ipcRenderer.sendSync('pixel:object-drag-begin', { source, offsetTicks }) || undefined,
  onObjectDrag: callback => {
    const off = listen('pixel:object-drag', callback);
    callback(ipcRenderer.sendSync('pixel:object-drag-active') || undefined);
    return off;
  },
  resolveObjectDrag: sessionId => ipcRenderer.sendSync('pixel:object-drag-resolve', sessionId) || undefined,
  finishObjectDrag: sessionId => ipcRenderer.sendSync('pixel:object-drag-finish', sessionId) || undefined,
  endObjectDrag: sessionId => ipcRenderer.send('pixel:object-drag-end', sessionId),
}));
