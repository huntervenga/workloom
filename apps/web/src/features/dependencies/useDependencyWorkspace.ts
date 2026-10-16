import type { GraphLayoutDto, GraphPositionDto, SetGraphLayoutInput, TaskDto } from '@workloom/contracts';
import { useCallback, useState } from 'react';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { useDependencyCommands } from './queries';
export interface EdgeDraft {
  id: string;
  anchor: TaskDto;
  direction: 'incoming' | 'outgoing';
  projectId: string;
  other: TaskDto | null;
  search: string;
}
export interface Point { x: number; y: number }
interface LayoutDraft { base: GraphLayoutDto | null; moves: Readonly<Record<string, Point>>; reset: boolean }
const changedEdge = (draft: EdgeDraft) => draft.other !== null || draft.search.trim() !== '' || draft.direction !== 'incoming' || draft.projectId !== draft.anchor.projectId;
const samePoint = (a: Point | undefined, b: Point) => a?.x === b.x && a.y === b.y;
export function fullLayoutInput(layout: LayoutDraft): SetGraphLayoutInput | null {
  if (layout.base === null) return null;
  const positions = new Map<string, GraphPositionDto>(layout.reset ? [] : layout.base.positions.map(position => [position.taskId, position]));
  for (const [taskId, point] of Object.entries(layout.moves)) positions.set(taskId, { taskId, ...point });
  return { expectedRevision: layout.base.revision, positions: [...positions.values()].sort((a, b) => a.taskId.localeCompare(b.taskId)) };
}
/** Page-owned commands and drafts survive every drawer, filter, root and view change. */
export function useDependencyWorkspace(actorId: string, workspaceId: string, projectId: string) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, EdgeDraft>>>({});
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const [layout, setLayout] = useState<LayoutDraft>({ base: null, moves: {}, reset: false });
  const [policyMode, setPolicyMode] = useState<'warn' | 'enforce' | null>(null);
  const [roots, setRoots] = useState<string[] | null>(null);
  const [rootOrigin, setRootOrigin] = useState<'loaded' | 'selected' | 'manual'>('loaded');
  const [depth, setDepth] = useState(1);
  const [canvas, setCanvas] = useState(() => typeof window === 'undefined' || window.innerWidth >= 768);
  const commands = useDependencyCommands(actorId, workspaceId, projectId, {
    onCreate: (_data, variables) => {
      setDrafts(before => Object.fromEntries(Object.entries(before).filter(([, draft]) => draft.id !== variables.draftId)));
      setActiveAnchor(current => current !== null && drafts[current]?.id === variables.draftId ? null : current);
    },
    onPolicy: (_data, variables) => setPolicyMode(current => current === variables.input.mode ? null : current),
    onLayout: (data, variables) => setLayout(current => ({
      base: current.base !== null && current.base.revision > data.revision ? current.base : data,
      moves: Object.fromEntries(Object.entries(current.moves).filter(([id, point]) => !samePoint(variables.input.positions.find(position => position.taskId === id), point))),
      // A confirmed replacement consumes the reset intent even when new positions were added.
      reset: false,
    })),
  });
  const openCreate = (anchor: TaskDto, other: TaskDto | null = null, direction: EdgeDraft['direction'] = 'incoming') => {
    setDrafts(before => before[anchor.id] ? before : { ...before, [anchor.id]: { id: crypto.randomUUID(), anchor, direction, projectId: other?.projectId ?? anchor.projectId, other, search: '' } });
    setActiveAnchor(anchor.id);
  };
  const changeDraft = (id: string, change: Partial<Pick<EdgeDraft, 'direction' | 'projectId' | 'other' | 'search'>>) => setDrafts(before => Object.fromEntries(Object.entries(before).map(([key, draft]) => [key, draft.id === id ? { ...draft, ...change } : draft])));
  const discardDraft = (id: string) => {
    if (commands.create.pendingCommand?.variables.draftId === id || commands.create.uncertain?.variables.draftId === id) return;
    setDrafts(before => Object.fromEntries(Object.entries(before).filter(([, draft]) => draft.id !== id)));
    setActiveAnchor(current => current !== null && drafts[current]?.id === id ? null : current);
  };
  const adoptLayout = useCallback((fresh: GraphLayoutDto) => setLayout(current => {
    if (Object.keys(current.moves).length || current.reset || current.base !== null && fresh.revision <= current.base.revision) return current;
    return { ...current, base: fresh };
  }), []);
  const rebaseLayout = (fresh: GraphLayoutDto) => setLayout(current => current.base !== null && fresh.revision < current.base.revision ? current : { ...current, base: fresh });
  const move = (taskId: string, point: Point) => {
    if (commands.layout.pendingCommand || commands.layout.uncertain || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 100000 || Math.abs(point.y) > 100000) return;
    setLayout(current => ({ ...current, moves: samePoint(current.reset ? undefined : current.base?.positions.find(position => position.taskId === taskId), point) ? Object.fromEntries(Object.entries(current.moves).filter(([id]) => id !== taskId)) : { ...current.moves, [taskId]: point } }));
  };
  const resetLayout = () => { if (!commands.layout.pendingCommand && !commands.layout.uncertain) setLayout(current => ({ ...current, moves: {}, reset: true })); };
  const discardLayout = () => { if (!commands.layout.pendingCommand && !commands.layout.uncertain) setLayout(current => ({ ...current, moves: {}, reset: false })); };
  const layoutDirty = Object.keys(layout.moves).length > 0 || layout.reset;
  const dirty = Object.values(drafts).some(changedEdge) || layoutDirty || policyMode !== null;
  useProtectedDraft(dirty);
  useUnsavedChangesWarning(dirty);
  return { commands, drafts, activeAnchor, setActiveAnchor, activeDraft: activeAnchor === null ? null : drafts[activeAnchor] ?? null, openCreate, changeDraft, discardDraft,
    policyMode, setPolicyMode, roots, setRoots, rootOrigin, setRootOrigin, depth, setDepth, canvas, setCanvas,
    layout, layoutDirty, adoptLayout, rebaseLayout, move, resetLayout, discardLayout, layoutInput: fullLayoutInput(layout) };
}
export type DependencyWorkspace = ReturnType<typeof useDependencyWorkspace>;
