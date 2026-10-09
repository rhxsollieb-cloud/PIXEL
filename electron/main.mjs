import { app, dialog, ipcMain, Menu, session } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWorkbenchServer, preparePixelProjectLocation, FileArtifactStore } from './backend.mjs';
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
let activeDirectory;
let activeToken;
let projectUnsubscribe;
let switchingProject = false;
let projectSwitchTask;
let closing = false;
let shutdownComplete = false;
const projectStops = new WeakMap();
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
  return Boolean(!switchingProject && !closing && host?.alive && host.window.isEnabled() && !(detail?.alive && detail.parent === host));
}
function createHost(role, parent) {
  const host = new DesktopWindowHost({ role, projectId: runtime.workbench.projectId, directory: electronDirectory, baseUrl, hidden: hideWindows, ...(parent ? { parent } : {}) });
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
  if (switchingProject || closing) throw new Error('The project is changing');
  const owner = runtime.workbench;
  const value = launch?.object;
  if (!value || typeof value !== 'object' || !['project', 'timeline', 'item', 'asset'].includes(value.kind)
      || value.projectId !== runtime.workbench.projectId || (value.kind !== 'project' && (typeof value.id !== 'string' || !value.id || value.id.length > 200))) {
    throw new Error('Invalid detail object');
  }
  if (launch.view !== undefined) throw new Error('The library opens through its independent host');
  const snapshot = await owner.snapshot();
  if (switchingProject || closing || owner !== runtime.workbench) throw new Error('The project is changing');
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
async function createProjectRuntime(directory, initial) {
  const token = randomBytes(32).toString('hex');
  const next = await startWorkbenchServer({
    directory, apiPort: 0, frontendDirectory: join(appDirectory, 'dist'), sessionToken: token,
    ...(initial ? { initial } : {}),
    envPath: join(app.isPackaged ? app.getPath('userData') : appDirectory, '.env'),
    ...(process.argv.includes('--pixel-test-storage') && process.env.NODE_ENV === 'test' ? { artifacts: new FileArtifactStore(join(directory, 'artifacts')) } : {}),
  });
  const address = next.server.address();
  if (!address || typeof address === 'string') {
    await stopProject(next);
    throw new Error('Desktop backend address unavailable');
  }
  return { runtime: next, url: `http://127.0.0.1:${address.port}/`, directory, token };
}
async function bindProject(next) {
  // Stage fallible reads and cookie installation before publishing any globals.
  const snapshot = await next.runtime.workbench.snapshot();
  await session.defaultSession.cookies.set({ url: next.url, name: 'pixel_desktop_session', value: next.token, httpOnly: true, sameSite: 'strict', path: '/' });
  projectUnsubscribe?.();
  runtime = next.runtime; baseUrl = next.url; activeDirectory = next.directory; activeToken = next.token;
  pendingRevision = 0;
  currentSnapshot = snapshot;
  const owner = runtime.workbench;
  objectDrags = new ObjectDragBroker({
    project: () => currentSnapshot && currentSnapshot.revision >= pendingRevision ? currentSnapshot : undefined,
    window: id => { const host = hosts.get(id); return host?.alive ? { id, projectId: host.projectId, interactive: interactive(host) } : undefined; },
    notify: drag => { for (const host of hosts.values()) host.send('pixel:object-drag', drag); },
  });
  exportTickets = new ExportTickets(runtime.workbench, assetId => currentSnapshot && currentSnapshot.revision >= pendingRevision ? currentSnapshot.document.assets[assetId] : undefined);
  projectUnsubscribe = owner.subscribe(event => {
    if (owner !== runtime.workbench || event.type !== 'project.changed') return;
    pendingRevision = Math.max(pendingRevision, event.revision);
    void owner.snapshot().then(snapshot => {
      if (owner !== runtime.workbench) return;
      if (!currentSnapshot || snapshot.revision >= currentSnapshot.revision) currentSnapshot = snapshot;
      objectDrags.reconcile();
    }).catch(() => {});
  });
}
function stopProject(previous) {
  const existing = projectStops.get(previous);
  if (existing) return existing;
  const stopped = previous.workbench.shutdown();
  const closed = new Promise(resolve => previous.server.close(resolve));
  previous.server.closeAllConnections();
  const task = Promise.all([stopped, closed]);
  projectStops.set(previous, task);
  return task;
}
async function rememberProject(directory) {
  const root = app.getPath('userData');
  await mkdir(root, { recursive: true });
  const pending = join(root, `last-project.${randomUUID()}.tmp`);
  try {
    await writeFile(pending, JSON.stringify({ version: 1, directory }), { flag: 'wx' });
    await rename(pending, join(root, 'last-project.json'));
  } finally { await unlink(pending).catch(() => {}); }
}
async function openDroppedProject(event, request) {
  if (trustedWindow(event) !== workspace || !interactive(workspace) || switchingProject || closing) {
    return { ok: false, error: '当前窗口暂时不能切换项目' };
  }
  switchingProject = true;
  const host = workspace;
  const previous = { runtime, url: baseUrl, directory: activeDirectory, token: activeToken };
  let next;
  try {
    const targetArtifacts = process.argv.includes('--pixel-test-storage') && process.env.NODE_ENV === 'test'
      ? new FileArtifactStore(join((await stat(request?.path)).isDirectory() ? request.path : dirname(request.path), 'artifacts'))
      : runtime.workbench.artifacts;
    const location = await preparePixelProjectLocation(request?.path, { artifacts: targetArtifacts });
    if (closing || !host.alive) return { ok: false, error: '窗口已关闭' };
    if (location.directory === activeDirectory) return { ok: true, title: currentSnapshot.document.title };
    next = await createProjectRuntime(location.directory, location.initial);
    if (closing || !host.alive) throw new Error('Window closed during project preparation');
    // Revoke all relationships before changing the authoritative project.
    exportTickets.clear(); objectDrags.clear(); projectUnsubscribe?.();
    if (detail?.alive) detail.window.destroy();
    if (library?.alive) library.window.destroy();
    await bindProject(next);
    if (closing || !host.alive) throw new Error('Window closed during project activation');
    host.projectId = runtime.workbench.projectId;
    host.baseUrl = baseUrl;
    await host.window.loadURL(baseUrl);
    // The old runtime remains available until navigation succeeds. Its cookie
    // and IPC origin have already been revoked, and failed activation can restore it.
    // Navigation is the commit point. A cleanup failure cannot roll back to an
    // old workbench whose shutdown has already begun or stop the healthy new one.
    await stopProject(previous.runtime).catch(() => { console.error('Previous Pixel project shutdown did not complete cleanly'); });
    // A remembered directory is host state, never provider credentials.
    await rememberProject(location.directory).catch(() => {});
    return { ok: true, title: currentSnapshot.document.title };
  } catch (error) {
    let restored = runtime === previous.runtime;
    if (next) {
      if (runtime === next.runtime) {
        exportTickets.clear(); objectDrags.clear(); projectUnsubscribe?.();
      }
      if (!closing && host.alive) {
        try {
          await bindProject(previous);
          host.projectId = previous.runtime.workbench.projectId;
          host.baseUrl = previous.url;
          await host.window.loadURL(previous.url);
          restored = true;
        } catch { restored = false; }
      }
      if (next.runtime !== runtime) await stopProject(next.runtime).catch(() => {});
      if (previous.runtime !== runtime) await stopProject(previous.runtime).catch(() => {});
    }
    return { ok: false, error: typeof error?.code === 'string' ? error.message : restored ? '项目未能打开，当前项目已保留' : '项目切换未完成，请重新启动 Pixel' };
  } finally { switchingProject = false; }
}
async function start() {
  Menu.setApplicationMenu(null);
  const desktopSession = session.defaultSession;
  desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  desktopSession.setPermissionCheckHandler(() => false);
  let location = { directory: process.env.PIXEL_STORAGE_DIR || join(app.getPath('userData'), 'project') };
  try {
    const saved = JSON.parse(await readFile(join(app.getPath('userData'), 'last-project.json'), 'utf8'));
    if (saved.version === 1 && typeof saved.directory === 'string' && isAbsolute(saved.directory)) location = await preparePixelProjectLocation(saved.directory, {
      envPath: join(app.isPackaged ? app.getPath('userData') : appDirectory, '.env'),
      ...(process.argv.includes('--pixel-test-storage') && process.env.NODE_ENV === 'test' ? { artifacts: new FileArtifactStore(join(saved.directory, 'artifacts')) } : {}),
    });
  } catch { /* Unavailable remembered projects do not replace the fallback project. */ }
  await bindProject(await createProjectRuntime(location.directory, location.initial));
  desktopSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    callback({ cancel: new URL(details.url).origin !== new URL(baseUrl).origin });
  });
  ipcMain.handle('pixel:details-open', (event, launch) => {
    if (trustedWindow(event) !== workspace) throw new Error('Only the workspace may open a detail window');
    return openDetails(launch);
  });
  ipcMain.handle('pixel:project-open-drop', (event, request) => {
    const task = openDroppedProject(event, request);
    // A rejected concurrent drop must not replace the switch awaited during exit.
    if (!projectSwitchTask) {
      projectSwitchTask = task;
      void task.finally(() => { if (projectSwitchTask === task) projectSwitchTask = undefined; }).catch(() => {});
    }
    return task;
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
    try { event.returnValue = switchingProject || closing ? null : handle(trustedWindow(event), value) ?? null; }
    catch { event.returnValue = null; }
  });
  syncDrag('pixel:object-drag-begin', (host, request) => objectDrags.begin(host.id, request?.source, request?.offsetTicks));
  syncDrag('pixel:object-drag-active', host => objectDrags.activeFor(host.id));
  syncDrag('pixel:object-drag-resolve', (host, sessionId) => objectDrags.resolve(host.id, sessionId));
  syncDrag('pixel:object-drag-finish', (host, sessionId) => objectDrags.finish(host.id, sessionId));
  ipcMain.on('pixel:object-drag-end', (event, sessionId, canceled) => {
    try { objectDrags.end(trustedWindow(event).id, sessionId, canceled === true); } catch { /* Only an authenticated source can end its session. */ }
  });
  ipcMain.handle('pixel:export-prepare', (event, request) => {
    // Preparation is read-only and may run as the new renderer loads. Native
    // export-start remains blocked during activation, and retired tickets cannot
    // survive either a project switch or a failed navigation rollback.
    if (trustedWindow(event) !== workspace || closing || !workspace.alive || !workspace.window.isEnabled() || detail?.alive) throw new Error('Only the active Viewer may prepare exports');
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
    await openDetails({ object: { kind: 'project', projectId: runtime.workbench.projectId } });
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
  // A candidate runtime must finish or be disposed before stopping the active
  // one; otherwise quitting during a drop can strand a newly created server.
  void (async () => {
    await projectSwitchTask?.catch(() => {});
    exportTickets?.clear(); objectDrags?.clear();
    await stopProject(runtime).catch(() => {});
    shutdownComplete = true; app.quit();
  })();
});
