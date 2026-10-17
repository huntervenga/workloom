import type { QueryClient } from '@tanstack/react-query';
import { protectedCommandsFor } from './protectedCommands';
import { protectedDraftsFor } from './protectedDrafts';

const compositions = new WeakMap<QueryClient, boolean>();

export function setWorkspaceRefreshComposing(client: QueryClient, active: boolean): void {
  compositions.set(client, active);
}

const HIDDEN = '[hidden],[inert],[aria-hidden="true"],[data-state="closed"]';
const EDITING = 'input:not([type="hidden"]),textarea,select,[contenteditable=""],[contenteditable="true"]';
const SURFACES = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-choice-picker-menu],[aria-haspopup][aria-expanded="true"]';

function visible(element: Element): boolean {
  if (element.closest(HIDDEN)) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/** Read current DOM/registry state immediately before a refresh, including pristine controls. */
export function isWorkspaceRefreshProtected(client: QueryClient, composing = false, doc: Document = document): boolean {
  if (composing || compositions.get(client) === true || protectedDraftsFor(client).protecting || protectedCommandsFor(client).protecting) return true;
  const active = doc.activeElement;
  if (active instanceof Element && visible(active) && active.closest(EDITING) !== null) return true;
  return [...doc.querySelectorAll(SURFACES)].some(visible);
}

/** No polling of interaction state: focus, composition, registries and portal lifecycle wake it. */
export function observeWorkspaceRefreshInteraction(client: QueryClient, wake: () => void, doc: Document = document): () => void {
  const changed = () => queueMicrotask(wake);
  const draft = protectedDraftsFor(client).subscribe(changed);
  const command = protectedCommandsFor(client).subscribe(changed);
  doc.addEventListener('focusin', changed, true);
  doc.addEventListener('focusout', changed, true);
  const observer = new MutationObserver(changed);
  observer.observe(doc.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['hidden', 'inert', 'aria-hidden', 'aria-expanded', 'data-state'],
  });
  return () => {
    draft(); command(); observer.disconnect();
    doc.removeEventListener('focusin', changed, true);
    doc.removeEventListener('focusout', changed, true);
  };
}
