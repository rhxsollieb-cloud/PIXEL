import type { DeepReadonly, ProjectSnapshot, Unsubscribe } from '../src/contracts.js';
import type { DragSource, ObjectDragSession, ObjectDragTransport } from '../src/frontend.js';

export type BrowserObjectDrag = ObjectDragSession;

export interface BrowserWindowReaders {
  snapshot(): DeepReadonly<ProjectSnapshot> | undefined;
  interactive(): boolean;
}

export interface BrowserWindowHost extends ObjectDragTransport {
  readonly isLibraryWindow: boolean;
  readonly isDetailWindow: false;
  openLibrary(): Promise<void>;
  close(): void;
}

interface Client {
  owner: Window;
  readers: BrowserWindowReaders;
  notify(drag: BrowserObjectDrag | undefined): void;
}
interface Session {
  drag: BrowserObjectDrag;
  sourceClient: string;
  expiresAt: number;
  cancellation: (() => void) | undefined;
}
interface BrowserWindowHub {
  origin: string;
  clients: Map<string, Client>;
  session: Session | undefined;
  publish(): void;
  clear(): void;
}

declare global {
  interface Window { __pixelBrowserWindows?: BrowserWindowHub }
}

const TTL_MS = 15_000;
const END_GRACE_MS = 350;

function live(client: Client, origin: string, requireSourceScope = false): boolean {
  try { return !client.owner.closed && client.owner.location.origin === origin && (!requireSourceScope || client.readers.interactive()); }
  catch { return false; }
}

function sourceExists(source: DeepReadonly<DragSource>, client: Client): boolean {
  const project = client.readers.snapshot();
  const object = source.payload.object;
  if (!project || project.document.id !== object.projectId) return false;
  if (source.role === 'asset' && object.kind === 'asset') return Object.hasOwn(project.document.assets, object.id);
  if (source.role === 'item' && object.kind === 'item') return Object.hasOwn(project.document.items, object.id);
  return false;
}

function validSession(hub: BrowserWindowHub): Session | undefined {
  const session = hub.session;
  const source = session && hub.clients.get(session.sourceClient);
  return session && session.expiresAt > Date.now() && source && live(source, hub.origin, true) && sourceExists(session.drag.source, source) ? session : undefined;
}

function createHub(owner: Window): BrowserWindowHub {
  let timer: number | undefined;
  const hub: BrowserWindowHub = {
    origin: owner.location.origin,
    clients: new Map(),
    session: undefined,
    publish() {
      const session = validSession(hub);
      if (hub.session && !session) { hub.clear(); return; }
      for (const [id, client] of hub.clients) {
        if (client.owner.closed) { hub.clients.delete(id); continue; }
        const drag = session && live(client, hub.origin) && sourceExists(session.drag.source, client) ? session.drag : undefined;
        client.notify(drag);
      }
      if (session && timer === undefined) {
        timer = owner.setTimeout(() => { timer = undefined; hub.publish(); }, 250);
      }
    },
    clear() {
      hub.session?.cancellation?.();
      if (timer !== undefined) owner.clearTimeout(timer);
      timer = undefined;
      hub.session = undefined;
      for (const client of hub.clients.values()) client.notify(undefined);
    },
  };
  return hub;
}

function sharedHub(): BrowserWindowHub {
  let owner = window;
  try {
    if (window.opener && !window.opener.closed && window.opener.location.origin === location.origin) owner = window.opener;
  } catch { /* A different-origin opener cannot participate in this local transport. */ }
  const existing = owner.__pixelBrowserWindows;
  if (existing?.origin === location.origin) return existing;
  return owner.__pixelBrowserWindows = createHub(owner);
}

let cached: BrowserWindowHost | undefined;
let setReaders: ((readers: BrowserWindowReaders) => void) | undefined;

/** Same-origin development windows share only transient drag leases, never writable project state. */
export function browserWindowHost(readers?: BrowserWindowReaders): BrowserWindowHost {
  if (cached) { if (readers) setReaders?.(readers); return cached; }
  let currentReaders = readers ?? { snapshot: () => undefined, interactive: () => true };
  setReaders = next => { currentReaders = next; };
  const listeners = new Set<(drag: BrowserObjectDrag | undefined) => void>();
  const clientId = crypto.randomUUID();
  let hub: BrowserWindowHub | undefined;
  let popup: Window | null = null;
  const client: Client = {
    owner: window,
    readers: { snapshot: () => currentReaders.snapshot(), interactive: () => currentReaders.interactive() },
    notify(drag) { for (const listener of listeners) { try { listener(drag); } catch { /* One view must not interrupt another window. */ } } },
  };
  function connect(): BrowserWindowHub {
    const next = sharedHub();
    if (next !== hub) {
      if (hub?.session?.sourceClient === clientId) hub.clear();
      hub?.clients.delete(clientId);
      hub = next;
      hub.clients.set(clientId, client);
    }
    return next;
  }
  function resolve(token: string): BrowserObjectDrag | undefined {
    const broker = connect();
    const session = validSession(broker);
    if (!session) { if (broker.session) broker.clear(); return undefined; }
    return session.drag.sessionId === token && live(client, broker.origin) && sourceExists(session.drag.source, client) ? session.drag : undefined;
  }
  connect();
  window.addEventListener('focus', () => connect().publish());
  // A source window closing or refreshing ends its leases; a new document registers its own client.
  window.addEventListener('pagehide', () => {
    if (hub?.session?.sourceClient === clientId) hub.clear();
    hub?.clients.delete(clientId);
  });
  cached = {
    isLibraryWindow: new URLSearchParams(location.search).get('window') === 'library',
    isDetailWindow: false,
    async openLibrary() {
      // Keep window.open in the user gesture's synchronous stack so popup policies permit it.
      if (popup && !popup.closed) { popup.focus(); return; }
      popup = window.open('/?window=library', 'pixel-library', 'popup,width=720,height=760');
      if (!popup) throw new Error('浏览器未能打开素材库窗口');
      popup.focus();
    },
    close() { window.close(); },
    onObjectDrag(listener) {
      listeners.add(listener);
      const broker = connect();
      const session = validSession(broker);
      listener(session && live(client, broker.origin) && sourceExists(session.drag.source, client) ? session.drag : undefined);
      return () => { listeners.delete(listener); };
    },
    beginObjectDrag(source, offsetTicks) {
      if (source.role === 'external.media') return undefined;
      const broker = connect();
      if (!live(client, broker.origin, true) || !sourceExists(source, client) || !Number.isSafeInteger(offsetTicks) || offsetTicks < 0) return undefined;
      if (source.role !== 'asset' && source.role !== 'item') return undefined;
      const project = currentReaders.snapshot();
      if (source.role === 'item' && source.payload.object.kind === 'item' && offsetTicks > (project?.document.items[source.payload.object.id]?.durationTicks ?? -1)) return undefined;
      broker.clear();
      const object = source.payload.object;
      const copiedSource = Object.freeze({ role: source.role, payload: Object.freeze({ object: Object.freeze({ kind: object.kind, projectId: object.projectId, id: object.id }) }) }) as DeepReadonly<DragSource>;
      const drag = Object.freeze({ sessionId: crypto.randomUUID(), source: copiedSource, offsetTicks: source.role === 'asset' ? 0 : offsetTicks });
      broker.session = { drag, sourceClient: clientId, expiresAt: Date.now() + TTL_MS, cancellation: undefined };
      broker.publish();
      return drag.sessionId;
    },
    resolveObjectDrag: resolve,
    finishObjectDrag(token) {
      const drag = resolve(token);
      if (drag) connect().clear();
      return drag;
    },
    endObjectDrag(token, canceled = false) {
      const broker = connect();
      const session = broker.session;
      if (!session || session.drag.sessionId !== token || session.sourceClient !== clientId) return;
      if (canceled === true) { broker.clear(); return; }
      if (session.cancellation !== undefined) return;
      // Chromium may emit source dragend just before the receiving window handles drop.
      const timer = window.setTimeout(() => { if (broker.session === session) broker.clear(); }, END_GRACE_MS);
      session.cancellation = () => window.clearTimeout(timer);
    },
  };
  return cached;
}
