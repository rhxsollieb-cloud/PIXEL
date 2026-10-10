import type { ObjectRef, Unsubscribe } from '../src/contracts.js';
import type { ObjectDragSession, ObjectDragTransport } from '../src/frontend.js';

export type DesktopObjectDrag = ObjectDragSession;

/** Preload exposes window operations only; edits still use the shared Action bridge. */
export interface PixelDesktop extends ObjectDragTransport {
  readonly isDetailWindow: boolean;
  readonly isLibraryWindow: boolean;
  openDroppedProject(file: File): Promise<{ ok: boolean; title?: string; error?: string }>;
  openSharedProject(projectId: string): Promise<{ ok: boolean; title?: string; error?: string }>;
  openDetails(request: { object: ObjectRef }): Promise<void>;
  openLibrary(): Promise<void>;
  onLibraryClosed(listener: () => void): Unsubscribe;
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

export function initialDetailObject(projectId: string): ObjectRef | undefined {
  if (!window.pixelDesktop?.isDetailWindow) return undefined;
  try {
    const object: unknown = JSON.parse(new URLSearchParams(location.search).get('detail') ?? 'null');
    if (!object || typeof object !== 'object' || !('kind' in object) || !('projectId' in object) || object.projectId !== projectId) return undefined;
    if (object.kind === 'project') return { kind: 'project', projectId: object.projectId };
    if ((object.kind === 'item' || object.kind === 'timeline' || object.kind === 'asset') && 'id' in object && typeof object.id === 'string' && object.id.length > 0)
      return { kind: object.kind, projectId: object.projectId, id: object.id };
  } catch { /* Invalid local navigation never opens an arbitrary object. */ }
  return undefined;
}
