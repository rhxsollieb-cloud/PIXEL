import { randomBytes } from 'node:crypto';

function objectExists(object, snapshot) {
  if (!object || object.projectId !== snapshot?.document.id) return false;
  if (object.kind === 'project') return true;
  if (typeof object.id !== 'string' || !object.id || object.id.length > 200) return false;
  const record = object.kind === 'asset' ? snapshot.document.assets : object.kind === 'item' ? snapshot.document.items : object.kind === 'timeline' ? snapshot.document.timelines : undefined;
  return Boolean(record && Object.hasOwn(record, object.id));
}
function sourceOf(source, snapshot, offsetTicks) {
  const object = source?.payload?.object;
  if (!objectExists(object, snapshot) || !Number.isSafeInteger(offsetTicks) || offsetTicks < 0) return undefined;
  const ref = { kind: object.kind, projectId: object.projectId, ...(object.kind === 'project' ? {} : { id: object.id }) };
  if (source.role === 'asset' && object.kind === 'asset' && offsetTicks === 0) return { role: 'asset', payload: { object: ref } };
  if (source.role === 'item' && object.kind === 'item' && offsetTicks <= snapshot.document.items[object.id].durationTicks) return { role: 'item', payload: { object: ref } };
  if (source.role === 'item.duration' && object.kind === 'item' && offsetTicks === 0 && ['start', 'end'].includes(source.payload.edge)) return { role: 'item.duration', payload: { object: ref, edge: source.payload.edge } };
  if (source.role === 'field.reference' && offsetTicks === 0 && typeof source.payload.fieldKey === 'string' && source.payload.fieldKey.trim() && source.payload.fieldKey.length <= 200) return { role: 'field.reference', payload: { object: ref, fieldKey: source.payload.fieldKey } };
  return undefined;
}

/** One OS drag owns one expiring, opaque session. No renderer JSON authorizes a drop. */
export class ObjectDragBroker {
  #active;
  constructor({ project, window, notify, now = Date.now, ttlMs = 120000, endGraceMs = 350 }) {
    this.project = project; this.window = window; this.notify = notify; this.now = now;
    this.ttlMs = ttlMs; this.endGraceMs = endGraceMs;
  }
  #peer(id) { const peer = this.window(id); return peer?.interactive ? peer : undefined; }
  #valid() {
    const session = this.#active;
    if (!session) return undefined;
    const snapshot = this.project();
    const sourceWindow = this.#peer(session.senderId);
    if (this.now() >= session.expiresAt || (session.endAt !== undefined && this.now() >= session.endAt)
        || !sourceWindow || sourceWindow.projectId !== session.projectId || !sourceOf(session.source, snapshot, session.offsetTicks)) {
      this.#clear(); return undefined;
    }
    return session;
  }
  #data(session) { return structuredClone({ sessionId: session.sessionId, source: session.source, offsetTicks: session.offsetTicks }); }
  #clear() {
    if (!this.#active) return;
    clearTimeout(this.#active.expiryTimer); clearTimeout(this.#active.endTimer);
    this.#active = undefined; this.notify(undefined);
  }
  begin(senderId, source, offsetTicks) {
    const snapshot = this.project(); const peer = this.#peer(senderId);
    const safeSource = sourceOf(source, snapshot, offsetTicks);
    if (!peer || !safeSource || peer.projectId !== snapshot.document.id) return undefined;
    this.#clear();
    const sessionId = randomBytes(32).toString('hex');
    const session = { sessionId, source: safeSource, offsetTicks, senderId, projectId: snapshot.document.id, expiresAt: this.now() + this.ttlMs };
    session.expiryTimer = setTimeout(() => { if (this.#active === session) this.#clear(); }, this.ttlMs);
    session.expiryTimer.unref?.(); this.#active = session;
    this.notify(this.#data(session)); return sessionId;
  }
  activeFor(receiverId) {
    const session = this.#valid(); const peer = this.#peer(receiverId);
    return session && peer?.projectId === session.projectId ? this.#data(session) : undefined;
  }
  resolve(receiverId, sessionId) {
    if (typeof sessionId !== 'string') return undefined;
    const session = this.#valid(); const peer = this.#peer(receiverId);
    return session?.sessionId === sessionId && peer?.projectId === session.projectId ? this.#data(session) : undefined;
  }
  finish(receiverId, sessionId) {
    const data = this.resolve(receiverId, sessionId);
    if (data) this.#clear(); return data;
  }
  end(senderId, sessionId) {
    const session = this.#valid();
    if (!session || session.sessionId !== sessionId || session.senderId !== senderId || session.endAt !== undefined) return;
    // Source dragend can arrive just before another renderer's drop; keep its
    // broadcast and token until the receiver atomically consumes or grace expires.
    session.endAt = this.now() + this.endGraceMs;
    session.endTimer = setTimeout(() => { if (this.#active === session) this.#clear(); }, this.endGraceMs);
    session.endTimer.unref?.();
  }
  destroyWindow(senderId) { if (this.#active?.senderId === senderId) this.#clear(); }
  reconcile() { this.#valid(); }
  clear() { this.#clear(); }
}
