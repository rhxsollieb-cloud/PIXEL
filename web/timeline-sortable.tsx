import type { HTMLAttributes, ReactNode } from 'react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import './timeline-sortable.css';

export function TimelineSortHost({ ids, disabled, onMove, children }: {
  ids: string[]; disabled?: boolean; onMove(id: string, beforeId?: string): void; children: ReactNode;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
    if (disabled || !over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id)); const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const order = arrayMove(ids, from, to);
    onMove(String(active.id), order[order.indexOf(String(active.id)) + 1]);
  }}>
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>{children}</SortableContext>
  </DndContext>;
}

export function SortableTimelineRow({ id, title, disabled, children, style, ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'id'> & {
  id: string; title: string; disabled?: boolean; children(handle: ReactNode): ReactNode;
}) {
  const sortable = useSortable({ id, disabled: Boolean(disabled) });
  const handle = <button ref={sortable.setActivatorNodeRef} type="button" className="timeline-sort-handle" data-testid="timeline-sort-handle" aria-label={`上下移动${title}时间线`}
    disabled={disabled} {...sortable.attributes} {...sortable.listeners}
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>↕</button>;
  return <div {...props} ref={sortable.setNodeRef} style={{ ...style, transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition,
    ...(sortable.isDragging ? { position: 'relative', zIndex: 8, opacity: 0.8 } : {}) }}>
    {children(handle)}
  </div>;
}
