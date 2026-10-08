import { app, dialog, ipcMain, Menu, session } from 'electron';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWorkbenchServer } from './backend.mjs';
import { ExportTickets } from './export-tickets.mjs';
import { DesktopWindowHost } from './window-host.mjs';
import { ObjectDragBroker } from './object-drag-broker.mjs';

const electronDirectory = fileURLToPath(new URL('.', import.meta.url));
const appDirectory = fileURLToPath(new URL('..', import.meta.url));
app.setName('Pixel');
app.setAppUserModelId('cloud.rhxsollieb.pixel');
app.setPath('userData', join(app.getPath('appData'), 'Pixel'));

let workspace;
let detail;
let library;
const hosts = new Map();
let runtime;
let baseUrl;
let exportTickets;
let objectDrags;
let currentSnapshot;
let pendingRevision = 0;
let closing = false;
let shutdownComplete = false;
const smoke = process.argv.includes('--pixel-smoke');
const hideWindows = smoke || process.argv.includes('--pixel-test');

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const target = detail?.alive ? detail : workspace;
    target?.focus();
  });
  app.whenReady().then(start).catch(error => {
    console.error(`Pixel desktop startup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    if (!smoke) dialog.showErrorBox('Pixel', '本地工作台未能启动。请检查项目存储与安装文件。');
    app.exit(1);
  });
}

function trustedWindow(event) {
  const host = hosts.get(event.sender.id);
  if (!host?.accepts(event, baseUrl)) throw new Error('Untrusted desktop sender');
  return host;
}
function interactive(host) {
  return Boolean(host?.alive && host.window.isEnabled() && !(detail?.alive && detail.parent === host));
}
function createHost(role, parent) {
  const host = new DesktopWindowHost({ role, projectId: 'pixel-project', directory: electronDirectory, baseUrl, hidden: hideWindows, ...(parent ? { parent } : {}) });
  const id = host.id;
  hosts.set(id, host);
  // A drag belongs to its source document, never to a renderer recreated under
  // the same WebContents ID after reload, navigation, or a crash.
  host.window.webContents.on('did-start-navigation', event => {
    if (event.isMainFrame) objectDrags?.destroyWindow(id);
  });
  host.window.webContents.on('render-process-gone', () => objectDrags?.destroyWindow(id));
  host.window.on('closed', () => {
    hosts.delete(id); objectDrags?.destroyWindow(id);
  });
  return host;
}
async function openLibrary() {
  if (library?.alive) { if (!hideWindows) library.focus(); return; }
  // The library is an independent, nonmodal peer with no native owner.
  library = createHost('library');
  const host = library;
  host.window.once('closed', () => {
    if (library === host) library = undefined;
    if (!closing) workspace?.send('pixel:library-closed');
  });
  try {
    await host.window.loadURL(`${baseUrl}?window=library`);
    if (!hideWindows && host.alive) host.window.show();
  } catch (error) { host.window.destroy(); throw error; }
}
async function openDetails(launch) {
  const value = launch?.object;
  if (!value || typeof value !== 'object' || !['project', 'timeline', 'item', 'asset'].includes(value.kind)
      || value.projectId !== 'pixel-project' || (value.kind !== 'project' && (typeof value.id !== 'string' || !value.id || value.id.length > 200))) {
    throw new Error('Invalid detail object');
  }
  if (launch.view !== undefined) throw new Error('The library opens through its independent host');
  const snapshot = await runtime.workbench.snapshot();
  const record = value.kind === 'timeline' ? snapshot.document.timelines : value.kind === 'item' ? snapshot.document.items : snapshot.document.assets;
  if (value.kind !== 'project' && !Object.hasOwn(record, value.id)) throw new Error('Detail object no longer exists');
  if (detail?.alive) { if (!hideWindows) detail.focus(); return; }
  const object = { kind: value.kind, projectId: value.projectId, ...(value.kind !== 'project' ? { id: value.id } : {}) };
  if (!workspace?.alive) throw new Error('Detail parent has closed');
  detail = createHost('detail', workspace);
  const child = detail;
  child.window.once('closed', () => {
    if (detail === child) detail = undefined;
    if (!closing) workspace?.send('pixel:details-closed');
  });
  try {
    await child.window.loadURL(`${baseUrl}?detail=${encodeURIComponent(JSON.stringify(object))}`);
    if (!hideWindows && child.alive) child.window.show();
  }
  catch (error) { child.window.destroy(); throw error; }
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
  objectDrags = new ObjectDragBroker({
    project: () => currentSnapshot && currentSnapshot.revision >= pendingRevision ? currentSnapshot : undefined,
    window: id => { const host = hosts.get(id); return host?.alive ? { id, projectId: host.projectId, interactive: interactive(host) } : undefined; },
    notify: drag => { for (const host of hosts.values()) host.send('pixel:object-drag', drag); },
  });
  exportTickets = new ExportTickets(runtime.workbench, assetId => currentSnapshot && currentSnapshot.revision >= pendingRevision ? currentSnapshot.document.assets[assetId] : undefined);
  runtime.workbench.subscribe(event => {
    if (event.type !== 'project.changed') return;
    pendingRevision = Math.max(pendingRevision, event.revision);
    void runtime.workbench.snapshot().then(snapshot => {
      if (!currentSnapshot || snapshot.revision >= currentSnapshot.revision) currentSnapshot = snapshot;
      objectDrags.reconcile();
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
  ipcMain.handle('pixel:library-open', event => {
    const host = trustedWindow(event);
    if (host.role === 'detail' || !interactive(host)) throw new Error('The window is not an active library entry');
    return openLibrary();
  });
  ipcMain.handle('pixel:window-control', (event, operation) => {
    trustedWindow(event).control(operation);
  });
  ipcMain.handle('pixel:window-maximized', event => trustedWindow(event).window.isMaximized());
  const syncDrag = (channel, handle) => ipcMain.on(channel, (event, value) => {
    try { event.returnValue = handle(trustedWindow(event), value) ?? null; }
    catch { event.returnValue = null; }
  });
  syncDrag('pixel:object-drag-begin', (host, request) => objectDrags.begin(host.id, request?.source, request?.offsetTicks));
  syncDrag('pixel:object-drag-active', host => objectDrags.activeFor(host.id));
  syncDrag('pixel:object-drag-resolve', (host, sessionId) => objectDrags.resolve(host.id, sessionId));
  syncDrag('pixel:object-drag-finish', (host, sessionId) => objectDrags.finish(host.id, sessionId));
  ipcMain.on('pixel:object-drag-end', (event, sessionId) => {
    try { objectDrags.end(trustedWindow(event).id, sessionId); } catch { /* Only an authenticated source can end its session. */ }
  });
  ipcMain.handle('pixel:export-prepare', (event, request) => {
    if (trustedWindow(event) !== workspace) throw new Error('Only the Viewer may prepare exports');
    return exportTickets.prepare(request?.assetId, event.sender.id);
  });
  ipcMain.on('pixel:export-start', (event, ticket) => {
    try {
      if (trustedWindow(event) !== workspace || !interactive(workspace)) return;
      const file = exportTickets.take(ticket, event.sender.id);
      if (file) event.sender.startDrag({ file, icon: join(electronDirectory, 'icon.png') });
    } catch { /* Invalid or expired tickets never become filesystem drags. */ }
  });
  workspace = createHost('workspace');
  workspace.window.on('closed', () => { workspace = undefined; if (!closing) app.quit(); });
  await workspace.window.loadURL(baseUrl);
  if (!hideWindows && workspace.alive) workspace.window.show();
  if (smoke) {
    const loaded = await workspace.window.webContents.executeJavaScript("Boolean(document.querySelector('#root')?.children.length && window.pixelDesktop && !window.pixelDesktop.isDetailWindow)");
    if (!loaded) throw new Error('Desktop renderer or isolated bridge not ready');
    await openDetails({ object: { kind: 'project', projectId: 'pixel-project' } });
    const childLoaded = await detail.window.webContents.executeJavaScript("Boolean(window.pixelDesktop?.isDetailWindow && new URLSearchParams(location.search).has('detail'))");
    if (!childLoaded || detail.window.getParentWindow() !== workspace.window || !detail.window.isModal()) throw new Error('Independent modal detail host not ready');
    console.log('PIXEL_DESKTOP_SMOKE_OK');
    detail.window.close();
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
  objectDrags?.clear();
  // Persist interrupted jobs before the single backend process exits.
  const stopped = runtime.workbench.shutdown();
  const closed = new Promise(resolve => runtime.server.close(resolve));
  runtime.server.closeAllConnections();
  Promise.allSettled([stopped, closed]).then(() => { shutdownComplete = true; app.quit(); });
});
