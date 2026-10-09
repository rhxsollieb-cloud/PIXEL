import type { DeepReadonly, ProjectSnapshot } from '../src/contracts.js';
import type { DragSource, ObjectDragSession } from '../src/frontend.js';

export interface ObjectDragPeer { id: number; projectId: string; interactive: boolean }
export class ObjectDragBroker {
  constructor(options: {
    project: () => DeepReadonly<ProjectSnapshot> | undefined;
    window: (id: number) => ObjectDragPeer | undefined;
    notify: (drag: ObjectDragSession | undefined) => void;
    now?: () => number; ttlMs?: number; endGraceMs?: number;
  });
  begin(senderId: number, source: DeepReadonly<DragSource>, offsetTicks: number): string | undefined;
  activeFor(receiverId: number): ObjectDragSession | undefined;
  resolve(receiverId: number, sessionId: string): ObjectDragSession | undefined;
  finish(receiverId: number, sessionId: string): ObjectDragSession | undefined;
  end(senderId: number, sessionId: string, canceled?: boolean): void;
  destroyWindow(senderId: number): void;
  reconcile(): void;
  clear(): void;
}
