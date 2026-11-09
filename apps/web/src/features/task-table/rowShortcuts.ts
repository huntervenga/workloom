export type RowShortcut = 'assign' | 'assignMe' | 'date' | 'complete' | 'copy' | 'help';

const actions: Readonly<Record<string, RowShortcut>> = {
  KeyA: 'assign', KeyM: 'assignMe', KeyD: 'date', KeyC: 'complete', KeyL: 'copy',
};

export function rowShortcut(event: KeyboardEvent, row: HTMLElement): RowShortcut | null {
  const target = event.target;
  if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey ||
      !(target instanceof Element) || !row.contains(target) ||
      target.closest('input,textarea,select,[contenteditable],[role="combobox"],[role="dialog"],[role="menu"],[role="listbox"]')) return null;
  if (event.key === '?') return 'help';
  return event.shiftKey ? actions[event.code] ?? null : null;
}
