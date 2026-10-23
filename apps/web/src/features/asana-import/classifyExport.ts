export type ExportKind = 'json' | 'csv' | 'unknown';

/** What the beginning of an Asana export file looks like; a byte-order mark and leading whitespace are ignored. */
export function classifyExportText(head: string): ExportKind {
  const text = head.replace(/^\u{feff}/u, '').trimStart();
  if (text.startsWith('{') || text.startsWith('[')) return 'json';
  if (/^"?Task ID"?\s*,/.test(text)) return 'csv';
  return 'unknown';
}

export async function classifyExport(file: Blob): Promise<ExportKind> {
  return classifyExportText(new TextDecoder().decode((await file.arrayBuffer()).slice(0, 256)));
}

/**
 * The two files in the order the importer needs, whichever field each was chosen in. Clearly swapped files are put right, two
 * files of the same kind are refused (`null`), and anything unrecognized is left to the server to judge.
 */
export async function orderExportFiles<T extends Blob>(first: T, second: T): Promise<{ json: T; csv: T } | null> {
  const [a, b] = await Promise.all([classifyExport(first), classifyExport(second)]);
  if (a === 'csv' && b === 'json') return { json: second, csv: first };
  if (a !== 'unknown' && a === b) return null;
  return { json: first, csv: second };
}
