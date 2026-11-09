import { descriptionAttachmentLine } from '@workloom/contracts';

/** Rebase a pending drop over text typed while its bytes are being uploaded. */
export function rebaseDescriptionOffset(before: string, after: string, offset: number): number {
  if (before === after) return offset;
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix++;
  if (offset <= prefix) return offset;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > prefix && newEnd > prefix && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return offset >= oldEnd ? newEnd + offset - oldEnd : newEnd;
}

export function placeDescriptionFile(body: string, offset: number, id: string) {
  const before = body.slice(0, offset), after = body.slice(offset);
  const lead = before && !before.endsWith('\n') ? '\n' : '';
  const tail = after.startsWith('\n') ? '' : '\n';
  const line = descriptionAttachmentLine(id);
  return { body: before + lead + line + tail + after, next: before.length + lead.length + line.length + 1 };
}

function caretOffset(element: HTMLElement, x: number, y: number): number | null {
  const doc = element.ownerDocument;
  const position = doc.caretPositionFromPoint?.(x, y);
  const range = position ? null : doc.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? range?.startContainer;
  if (!node || !element.contains(node)) return null;
  const part = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-description-length]');
  const prefix = doc.createRange();
  prefix.selectNodeContents(part ?? element);
  prefix.setEnd(node, position?.offset ?? range?.startOffset ?? 0);
  const within = prefix.toString().length;
  if (!part) return within;
  // A Workloom link may show the task title instead of its longer source URL.
  let preceding = 0;
  for (const previous of element.children) {
    const length = Number(previous.getAttribute('data-description-length'));
    if (previous === part) {
      if (!part.hasAttribute('data-description-link')) return preceding + within;
      const afterLink = within * 2 >= (part.textContent?.length ?? 0);
      return preceding + (afterLink ? length : 0);
    }
    preceding += length;
  }
  return within;
}

/** The browser's textarea caret is inside its shadow DOM; mirror its line wrapping for hit testing. */
export function descriptionOffsetAt(element: HTMLElement, text: string, x: number, y: number): number {
  const rect = element.getBoundingClientRect();
  if (!rect.width || y > rect.bottom || y < rect.top) return text.length;
  if (!(element instanceof HTMLTextAreaElement)) return Math.min(text.length, caretOffset(element, x, y) ?? text.length);
  const mirror = document.createElement('div');
  const style = getComputedStyle(element);
  Object.assign(mirror.style, {
    position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, zIndex: '2147483647',
    width: `${element.clientWidth}px`, height: `${element.clientHeight}px`, boxSizing: 'border-box',
    margin: '0', padding: style.padding, font: style.font, lineHeight: style.lineHeight, direction: style.direction,
    letterSpacing: style.letterSpacing, tabSize: style.tabSize, textAlign: style.textAlign,
    whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden', opacity: '0',
  });
  mirror.setAttribute('aria-hidden', 'true');
  mirror.textContent = text + '\u200b';
  document.body.append(mirror);
  try {
    mirror.scrollTop = element.scrollTop;
    const px = Math.max(rect.left + 1, Math.min(x, rect.left + element.clientWidth - 1));
    return Math.min(text.length, caretOffset(mirror, px, y) ?? text.length);
  } finally { mirror.remove(); }
}
