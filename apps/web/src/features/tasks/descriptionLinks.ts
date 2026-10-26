export type DescriptionPart = { kind: 'text'; text: string } | { kind: 'link'; href: string };

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const TRAILING = /[.,;:!?)\]}]+$/;
const TASK_PATH = /\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Splits a description into plain text and http(s) links; punctuation that ends a sentence stays outside the link. */
export function splitDescription(text: string): DescriptionPart[] {
  const parts: DescriptionPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0], href = raw.replace(TRAILING, ''), start = match.index;
    if (href.length <= 'https://'.length) continue;
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    parts.push({ kind: 'link', href });
    last = start + href.length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

export const hasDescriptionLinks = (text: string): boolean => splitDescription(text).some(part => part.kind === 'link');

/** A link to a task of this service (`…/projects/<project>?task=<task>`), or null for any other address. */
export function parseTaskLink(href: string, origin: string): { projectId: string; taskId: string } | null {
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (url.origin !== origin) return null;
  const taskId = url.searchParams.get('task'), project = TASK_PATH.exec(url.pathname);
  return taskId !== null && UUID.test(taskId) && project?.[1] ? { projectId: project[1].toLowerCase(), taskId: taskId.toLowerCase() } : null;
}
