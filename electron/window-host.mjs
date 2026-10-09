import { BrowserWindow } from 'electron';
import { join } from 'node:path';

const dimensions = {
  workspace: { width: 1480, height: 960, minWidth: 1040, minHeight: 720, title: 'Pixel' },
  library: { width: 720, height: 760, minWidth: 480, minHeight: 400, title: 'Pixel · Media' },
  detail: { width: 720, height: 760, minWidth: 520, minHeight: 420, title: 'Pixel · Detail' },
};

/** Every desktop surface uses the same native shell, security and window controls. */
export class DesktopWindowHost {
  constructor({ role, projectId, directory, baseUrl, hidden, parent }) {
    if (!Object.hasOwn(dimensions, role)) throw new Error('Unknown desktop window role');
    this.role = role;
    this.projectId = projectId;
    this.baseUrl = baseUrl;
    this.parent = parent;
    this.window = new BrowserWindow({
      ...dimensions[role], frame: false, show: false, backgroundColor: '#f8f9f5',
      autoHideMenuBar: true, roundedCorners: false, icon: join(directory, 'icon.png'),
      ...(parent ? { parent: parent.window, modal: true, skipTaskbar: false } : {}),
      webPreferences: {
        preload: join(directory, 'preload.cjs'), contextIsolation: true, sandbox: true,
        nodeIntegration: false, webSecurity: true, spellcheck: false,
        additionalArguments: [`--pixel-window=${role}`],
      },
    });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event, url) => {
      try {
        const target = new URL(url);
        if (target.origin !== new URL(this.baseUrl).origin || target.pathname !== '/') event.preventDefault();
      } catch { event.preventDefault(); }
    });
    for (const name of ['maximize', 'unmaximize']) this.window.on(name, () => {
      if (!this.window.webContents.isDestroyed()) this.window.webContents.send('pixel:maximized', this.window.isMaximized());
    });
    this.window.once('ready-to-show', () => { if (!hidden) this.window.show(); });
  }
  get id() { return this.window.webContents.id; }
  get alive() { return !this.window.isDestroyed() && !this.window.webContents.isDestroyed(); }
  accepts(event, baseUrl) {
    if (!this.alive || event.sender !== this.window.webContents || event.senderFrame !== event.sender.mainFrame) return false;
    try { const url = new URL(event.senderFrame.url); return url.origin === new URL(baseUrl).origin && url.pathname === '/'; }
    catch { return false; }
  }
  control(operation) {
    if (operation === 'minimize') this.window.minimize();
    else if (operation === 'maximize') this.window.isMaximized() ? this.window.unmaximize() : this.window.maximize();
    else if (operation === 'close') this.window.close();
    else throw new Error('Unknown window operation');
  }
  focus() {
    if (!this.alive) return;
    if (this.parent?.alive && this.parent.window.isMinimized()) this.parent.window.restore();
    if (this.window.isMinimized()) this.window.restore();
    this.window.show(); this.window.focus();
  }
  send(channel, value) { if (this.alive) this.window.webContents.send(channel, value); }
}
