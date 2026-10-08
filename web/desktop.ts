import type { ObjectRef, Unsubscribe } from '../src/contracts.js';

/** Preload exposes window operations only; edits still use the shared Action bridge. */
export interface PixelDesktop {
  readonly isDetailWindow: boolean;
  openDetails(request: { object: ObjectRef; view?: 'library' }): Promise<void>;
  onDetailsClosed(listener: () => void): Unsubscribe;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  onMaximizedChanged(listener: (maximized: boolean) => void): Unsubscribe;
  prepareExport(request: { assetId: string }): Promise<{ ticket: string }>;
  startExport(ticket: string): void;
}

declare global {
  interface Window { pixelDesktop?: PixelDesktop }
}

export function initialDetailObject(): ObjectRef | undefined {
  if (!window.pixelDesktop?.isDetailWindow) return undefined;
  try {
    const object: unknown = JSON.parse(new URLSearchParams(location.search).get('detail') ?? 'null');
    if (!object || typeof object !== 'object' || !('kind' in object) || !('projectId' in object) || object.projectId !== 'pixel-project') return undefined;
    if (object.kind === 'project') return { kind: 'project', projectId: object.projectId };
    if ((object.kind === 'item' || object.kind === 'timeline' || object.kind === 'asset') && 'id' in object && typeof object.id === 'string' && object.id.length > 0)
      return { kind: object.kind, projectId: object.projectId, id: object.id };
  } catch { /* Invalid local navigation never opens an arbitrary object. */ }
  return undefined;
}

/** Only the project's library is a supported alternative root detail view. */
export function initialDetailView(): 'library' | undefined {
  return initialDetailObject()?.kind === 'project' && new URLSearchParams(location.search).get('view') === 'library' ? 'library' : undefined;
}
