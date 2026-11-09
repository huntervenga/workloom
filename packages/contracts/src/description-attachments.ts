// Ordinary descriptions stay plain text. Only descriptions with inline files use this
// versioned format. File IDs are references, never storage keys or signed URLs.
const header = '\u2063workloom-description:1\u2063\n';
const filePattern = /^\u2063file:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\u2063$/;

export function descriptionAttachmentId(line: string): string | null {
  return filePattern.exec(line)?.[1] ?? null;
}

export function descriptionAttachmentLine(id: string): string {
  return `\u2063file:${id}\u2063`;
}

export function isDescriptionWithFiles(value: string): boolean {
  return value.startsWith(header);
}

export function descriptionBody(value: string): string {
  return isDescriptionWithFiles(value) ? value.slice(header.length) : value;
}

export function descriptionWithFiles(body: string): string {
  return header + body;
}

export function descriptionPlainText(value: string): string {
  if (!isDescriptionWithFiles(value)) return value;
  return descriptionBody(value).split('\n').filter(line => !descriptionAttachmentId(line)).join('\n');
}

export function remapDescriptionFiles(value: string, copiedIds: ReadonlyMap<string, string>): string {
  if (!isDescriptionWithFiles(value)) return value;
  const body = descriptionBody(value).split('\n').flatMap(line => {
    const id = descriptionAttachmentId(line);
    if (!id) return [line];
    const copied = copiedIds.get(id);
    return copied ? [descriptionAttachmentLine(copied)] : [];
  }).join('\n');
  return descriptionWithFiles(body);
}
