export type DescriptionPart = { kind: 'text'; text: string } | { kind: 'link'; href: string };

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const TRAILING = /[.,;:!?)\]}]+$/;
const PROJECT_PATH = /^\/(?:app\/)?w\/([^/]+)\/projects\/([0-9a-f-]{36})\/?$/i;
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

export interface ProjectReference {
  workspaceReference: string;
  projectId: string;
  taskId: string | null;
}

/** Only canonical same-origin project or task URLs are eligible for title resolution. */
export function parseProjectReference(href: string, origin: string): ProjectReference | null {
  try {
    const url = new URL(href);
    if (url.origin !== origin || url.username || url.password) return null;
    const match = PROJECT_PATH.exec(url.pathname);
    const workspace = match?.[1], projectId = match?.[2], taskId = url.searchParams.get('task');
    if (!workspace || !projectId || !UUID.test(projectId) || (taskId !== null && !UUID.test(taskId))) return null;
    return { workspaceReference: decodeURIComponent(workspace), projectId: projectId.toLowerCase(), taskId: taskId?.toLowerCase() ?? null };
  } catch { return null; }
}

export function parseTaskLink(href: string, origin: string): { projectId: string; taskId: string } | null {
  const reference = parseProjectReference(href, origin);
  return reference?.taskId ? { projectId: reference.projectId, taskId: reference.taskId } : null;
}
