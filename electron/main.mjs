import { app, BrowserWindow, dialog, ipcMain, Menu, session } from 'electron';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWorkbenchServer } from './backend.mjs';
import { ExportTickets } from './export-tickets.mjs';

const electronDirectory = fileURLToPath(new URL('.', import.meta.url));
const appDirectory = fileURLToPath(new URL('..', import.meta.url));
app.setName('Pixel');
app.setAppUserModelId('cloud.rhxsollieb.pixel');
app.setPath('userData', join(app.getPath('appData'), 'Pixel'));

let workspace;
let detail;
let runtime;
let baseUrl;
let exportTickets;
let currentSnapshot;
let pendingRevision = 0;
let closing = false;
let shutdownComplete = false;
const smoke = process.argv.includes('--pixel-smoke');
const hideWindows = smoke || process.argv.includes('--pixel-test');

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (workspace && !workspace.isDestroyed() && workspace.isMinimized()) workspace.restore();
    const target = detail && !detail.isDestroyed() ? detail : workspace;
    if (!target || target.isDestroyed()) return;
    if (target.isMinimized()) target.restore();
    target.show(); target.focus();
  });
  app.whenReady().then(start).catch(error => {
    console.error(`Pixel desktop startup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    if (!smoke) dialog.showErrorBox('Pixel', '本地工作台未能启动。请检查项目存储与安装文件。');
    app.exit(1);
  });
}

function trustedWindow(event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || (window !== workspace && window !== detail) || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted desktop sender');
  const url = new URL(event.senderFrame.url);
  if (url.origin !== new URL(baseUrl).origin || url.pathname !== '/') throw new Error('Untrusted desktop page');
  return window;
}
function windowOptions(isDetail) {
  return {
    width: isDetail ? 720 : 1480, height: isDetail ? 760 : 960,
    minWidth: isDetail ? 520 : 1040, minHeight: isDetail ? 420 : 720,
    title: isDetail ? 'Pixel · Detail' : 'Pixel', frame: false, show: false,
    backgroundColor: '#f8f9f5', autoHideMenuBar: true, roundedCorners: false,
    icon: join(electronDirectory, 'icon.png'),
    // The modal needs its own taskbar entry so a minimized child can be restored
    // while Windows correctly keeps its owner disabled.
    ...(isDetail ? { parent: workspace, modal: true, skipTaskbar: false } : {}),
    webPreferences: {
      preload: join(electronDirectory, 'preload.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true, spellcheck: false,
      additionalArguments: [`--pixel-window=${isDetail ? 'detail' : 'workspace'}`],
    },
  };
}
function secureWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    if (target.origin !== new URL(baseUrl).origin || target.pathname !== '/') event.preventDefault();
  });
  for (const name of ['maximize', 'unmaximize']) window.on(name, () => {
    if (!window.webContents.isDestroyed()) window.webContents.send('pixel:maximized', window.isMaximized());
  });
  window.once('ready-to-show', () => { if (!hideWindows) window.show(); });
}
async function openDetails(launch) {
  const value = launch?.object;
  if (!value || typeof value !== 'object' || !['project', 'timeline', 'item', 'asset'].includes(value.kind)
      || value.projectId !== 'pixel-project' || (value.kind !== 'project' && (typeof value.id !== 'string' || !value.id || value.id.length > 200))) {
    throw new Error('Invalid detail object');
  }
  if (launch.view !== undefined && (launch.view !== 'library' || value.kind !== 'project')) throw new Error('Invalid detail view');
  const snapshot = await runtime.workbench.snapshot();
  const record = value.kind === 'timeline' ? snapshot.document.timelines : value.kind === 'item' ? snapshot.document.items : snapshot.document.assets;
  if (value.kind !== 'project' && !Object.hasOwn(record, value.id)) throw new Error('Detail object no longer exists');
  if (detail && !detail.isDestroyed()) { detail.focus(); return; }
  const object = { kind: value.kind, projectId: value.projectId, ...(value.kind !== 'project' ? { id: value.id } : {}) };
  detail = new BrowserWindow(windowOptions(true));
  secureWindow(detail);
  const child = detail;
  child.once('closed', () => {
    if (detail === child) detail = undefined;
    if (!closing && workspace && !workspace.isDestroyed() && !workspace.webContents.isDestroyed()) workspace.webContents.send('pixel:details-closed');
  });
  try {
    await child.loadURL(`${baseUrl}?detail=${encodeURIComponent(JSON.stringify(object))}${launch.view === 'library' ? '&view=library' : ''}`);
    if (!hideWindows && !child.isDestroyed()) child.show();
  }
  catch (error) { child.destroy(); throw error; }
}
async function start() {
  Menu.setApplicationMenu(null);
  const desktopSession = session.defaultSession;
  desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  desktopSession.setPermissionCheckHandler(() => false);
  const token = randomBytes(32).toString('hex');
  const directory = process.env.PIXEL_STORAGE_DIR || join(app.getPath('userData'), 'project');
  runtime = await startWorkbenchServer({
    directory, apiPort: 0, frontendDirectory: join(appDirectory, 'dist'), sessionToken: token,
    envPath: join(app.isPackaged ? app.getPath('userData') : appDirectory, '.env'),
  });
  const address = runtime.server.address();
  if (!address || typeof address === 'string') throw new Error('Desktop backend address unavailable');
  baseUrl = `http://127.0.0.1:${address.port}/`;
  currentSnapshot = await runtime.workbench.snapshot();
  exportTickets = new ExportTickets(runtime.workbench, assetId => currentSnapshot && currentSnapshot.revision >= pendingRevision ? currentSnapshot.document.assets[assetId] : undefined);
  runtime.workbench.subscribe(event => {
    if (event.type !== 'project.changed') return;
    pendingRevision = Math.max(pendingRevision, event.revision);
    void runtime.workbench.snapshot().then(snapshot => {
      if (!currentSnapshot || snapshot.revision >= currentSnapshot.revision) currentSnapshot = snapshot;
    }).catch(() => {});
  });
  await desktopSession.cookies.set({ url: baseUrl, name: 'pixel_desktop_session', value: token, httpOnly: true, sameSite: 'strict', path: '/' });
  desktopSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    callback({ cancel: new URL(details.url).origin !== new URL(baseUrl).origin });
  });
  ipcMain.handle('pixel:details-open', (event, launch) => {
    if (trustedWindow(event) !== workspace) throw new Error('Only the workspace may open a detail window');
    return openDetails(launch);
  });
  ipcMain.handle('pixel:window-control', (event, operation) => {
    const window = trustedWindow(event);
    if (operation === 'minimize') window.minimize();
    else if (operation === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
    else if (operation === 'close') window.close();
    else throw new Error('Unknown window operation');
  });
  ipcMain.handle('pixel:window-maximized', event => trustedWindow(event).isMaximized());
  ipcMain.handle('pixel:export-prepare', (event, request) => {
    if (trustedWindow(event) !== workspace) throw new Error('Only the Viewer may prepare exports');
    return exportTickets.prepare(request?.assetId, event.sender.id);
  });
  ipcMain.on('pixel:export-start', (event, ticket) => {
    try {
      if (trustedWindow(event) !== workspace || (detail && !detail.isDestroyed())) return;
      const file = exportTickets.take(ticket, event.sender.id);
      if (file) event.sender.startDrag({ file, icon: join(electronDirectory, 'icon.png') });
    } catch { /* Invalid or expired tickets never become filesystem drags. */ }
  });
  workspace = new BrowserWindow(windowOptions(false));
  secureWindow(workspace);
  workspace.on('closed', () => { workspace = undefined; });
  await workspace.loadURL(baseUrl);
  if (!hideWindows && !workspace.isDestroyed()) workspace.show();
  if (smoke) {
    const loaded = await workspace.webContents.executeJavaScript("Boolean(document.querySelector('#root')?.children.length && window.pixelDesktop && !window.pixelDesktop.isDetailWindow)");
    if (!loaded) throw new Error('Desktop renderer or isolated bridge not ready');
    await openDetails({ object: { kind: 'project', projectId: 'pixel-project' } });
    const childLoaded = await detail.webContents.executeJavaScript("Boolean(window.pixelDesktop?.isDetailWindow && new URLSearchParams(location.search).has('detail'))");
    if (!childLoaded || detail.getParentWindow() !== workspace || !detail.isModal()) throw new Error('Independent modal detail host not ready');
    console.log('PIXEL_DESKTOP_SMOKE_OK');
    detail.close();
    app.quit();
  }
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (shutdownComplete || !runtime) return;
  event.preventDefault();
  if (closing) return;
  closing = true;
  exportTickets?.clear();
  // Persist interrupted jobs before the single backend process exits.
  const stopped = runtime.workbench.shutdown();
  const closed = new Promise(resolve => runtime.server.close(resolve));
  runtime.server.closeAllConnections();
  Promise.allSettled([stopped, closed]).then(() => { shutdownComplete = true; app.quit(); });
});
