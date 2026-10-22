export interface JumpItem { readonly key: string; readonly label: string; readonly hint: string; readonly to: string }

const normal = (text: string) => text.normalize('NFC').trim().toLowerCase();

/** Items whose label contains every word typed, shortest label first so the closest name leads; no typing keeps the given order. */
export function filterJumpItems(items: readonly JumpItem[], query: string): JumpItem[] {
  const words = normal(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  return items.filter(item => words.every(word => normal(item.label).includes(word))).sort((a, b) => a.label.length - b.label.length);
}
