import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { stat } from 'node:fs/promises';

/** Tokens refer only to validated project media; renderers never supply a filesystem path. */
export class ExportTickets {
  #tickets = new Map();
  constructor(workbench, currentAsset) { this.workbench = workbench; this.currentAsset = currentAsset; }
  async prepare(assetId, senderId) {
    if (typeof assetId !== 'string' || !assetId || assetId.length > 200) throw new Error('Invalid export asset');
    const asset = await this.workbench.mediaAsset(assetId);
    const path = await this.workbench.artifacts.resolvePath(asset);
    const info = await stat(path);
    if (!info.isFile() || !info.size) throw new Error('Export media is not ready');
    for (const [token, grant] of this.#tickets) if (grant.expiresAt <= Date.now()) this.#tickets.delete(token);
    while (this.#tickets.size >= 64) this.#tickets.delete(this.#tickets.keys().next().value);
    const ticket = randomBytes(32).toString('hex');
    this.#tickets.set(ticket, { senderId, assetId, fileRef: asset.fileRef, path, expiresAt: Date.now() + 15 * 60 * 1000 });
    return { ticket };
  }
  take(ticket, senderId) {
    if (typeof ticket !== 'string') return undefined;
    const grant = this.#tickets.get(ticket);
    if (!grant || grant.senderId !== senderId) return undefined;
    this.#tickets.delete(ticket);
    const asset = this.currentAsset(grant.assetId);
    if (grant.expiresAt <= Date.now() || !asset || asset.fileRef !== grant.fileRef) return undefined;
    try { const info = statSync(grant.path); if (!info.isFile() || !info.size) return undefined; }
    catch { return undefined; }
    return grant.path;
  }
  clear() { this.#tickets.clear(); }
}
