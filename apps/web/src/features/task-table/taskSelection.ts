export interface SelectionModifiers { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }
/** Selection follows only the visible saved rows, never hidden/collapsed tasks or draft rows. */
export function selectTaskRows(current: readonly string[], visible: readonly string[], anchor: string | null, target: string, modifiers: SelectionModifiers, limit = 100): { ids: string[]; anchor: string; limitReached?: boolean } {
  if (!visible.includes(target)) return { ids: [...current], anchor: anchor ?? target };
  const additive = modifiers.ctrlKey === true || modifiers.metaKey === true;
  if (modifiers.shiftKey && anchor !== null && visible.includes(anchor)) {
    const first = visible.indexOf(anchor); const last = visible.indexOf(target);
    const range = visible.slice(Math.min(first, last), Math.max(first, last) + 1);
    const desired = [...new Set(additive ? [...current, ...range] : range)];
    return desired.length > limit ? { ids: [...current], anchor, limitReached: true } : { ids: desired, anchor };
  }
  const desired = additive ? (current.includes(target) ? current.filter(id => id !== target) : [...current, target]) : [target];
  return desired.length > limit ? { ids: [...current], anchor: anchor ?? target, limitReached: true } : { ids: desired, anchor: target };
}
