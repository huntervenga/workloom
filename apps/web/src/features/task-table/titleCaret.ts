/** Both browser caret hit-tests; either may be missing (jsdom, older engines). */
interface CaretDocument {
  caretPositionFromPoint?: ((x: number, y: number) => { offsetNode: Node; offset: number } | null) | undefined;
  caretRangeFromPoint?: ((x: number, y: number) => Range | null) | undefined;
}

function caretHit(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as unknown as CaretDocument;
  if (typeof doc.caretPositionFromPoint === 'function') {
    const position = doc.caretPositionFromPoint(x, y);
    if (position) return { node: position.offsetNode, offset: position.offset };
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

/**
 * The text offset in `title` under a pointer, or undefined when the browser gives no hit inside
 * this very element. Any absent or throwing API falls back to the editor's default caret.
 */
export function titleCaretFromPoint(title: HTMLElement, x: number, y: number): number | undefined {
  try {
    const hit = caretHit(x, y);
    if (!hit || !title.contains(hit.node)) return undefined;
    const prefix = document.createRange();
    prefix.setStart(title, 0);
    prefix.setEnd(hit.node, hit.offset);
    const offset = prefix.toString().length;
    return Math.min(Math.max(offset, 0), title.textContent?.length ?? 0);
  } catch {
    return undefined;
  }
}
