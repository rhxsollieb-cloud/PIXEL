import type { DeepReadonly, ProjectSnapshot } from '../src/contracts.js';
import type { DragSource } from '../src/frontend.js';
import type { DesktopObjectDrag } from '../web/desktop.js';

export interface ObjectDragPeer { id: number; projectId: string; interactive: boolean }
export class ObjectDragBroker {
  constructor(options: {
    project: () => DeepReadonly<ProjectSnapshot> | undefined;
    window: (id: number) => ObjectDragPeer | undefined;
    notify: (drag: DesktopObjectDrag | undefined) => void;
    now?: () => number; ttlMs?: number; endGraceMs?: number;
  });
  begin(senderId: number, source: DragSource, offsetTicks: number): string | undefined;
  activeFor(receiverId: number): DesktopObjectDrag | undefined;
  resolve(receiverId: number, sessionId: string): DesktopObjectDrag | undefined;
  finish(receiverId: number, sessionId: string): DesktopObjectDrag | undefined;
  end(senderId: number, sessionId: string): void;
  destroyWindow(senderId: number): void;
  reconcile(): void;
  clear(): void;
}
