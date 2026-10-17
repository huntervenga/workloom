import { createPortal } from 'react-dom';
import { GripVertical } from 'lucide-react';
import type { TaskDto } from '@workloom/contracts';
/** A presentation-only card. The saved row and its geometry stay in place until server confirmation. */
export function TaskDragPreview({ task, pointer }: { task: TaskDto; pointer: { x: number; y: number } }) {
  return createPortal(<div data-testid="task-drag-preview" data-task-drag-preview={task.id} aria-hidden="true"
    style={{ position: 'fixed', left: Math.max(8, Math.min(pointer.x + 12, window.innerWidth - Math.min(288, window.innerWidth - 32) - 12)), top: Math.max(8, Math.min(pointer.y + 12, window.innerHeight - 53)), pointerEvents: 'none', zIndex: 1000 }}
    className="flex h-[41px] w-72 max-w-[calc(100vw-2rem)] items-center gap-2 rounded-lg border border-accent-line bg-surface px-3 text-sm text-ink shadow-xl">
    <GripVertical size={14} className="shrink-0 text-muted" /><span className="truncate">{task.title}</span>
  </div>, document.body);
}
