export interface Mentionable { readonly id: string; readonly displayName: string; readonly pending?: boolean | undefined }

const WORD = /[\p{L}\p{N}_]/u;
const fold = (text: string) => text.normalize('NFC').toLowerCase();

/** Members named as "@Name" in the text; a name must end where a word ends, so "@Ann" does not name "Annabel". */
export function findMentions(body: string, members: readonly Mentionable[]): string[] {
  const text = fold(body);
  const found = new Set<string>();
  // Longest names first, so "@Ann Lee" is not also read as "@Ann".
  const byLength = [...members].filter(member => !member.pending && member.displayName.trim() !== '').sort((a, b) => b.displayName.length - a.displayName.length);
  const taken: [number, number][] = [];
  for (const member of byLength) {
    const needle = `@${fold(member.displayName.trim())}`;
    for (let from = text.indexOf(needle); from !== -1; from = text.indexOf(needle, from + 1)) {
      const end = from + needle.length;
      if (WORD.test(text[end] ?? ' ')) continue;
      if (from > 0 && WORD.test(text[from - 1] ?? ' ')) continue;
      if (taken.some(([a, b]) => from < b && end > a)) continue;
      taken.push([from, end]);
      found.add(member.id);
    }
  }
  return [...found];
}

/** The "@query" being typed right before the caret, or null. */
export function mentionQueryAt(body: string, caret: number): { start: number; query: string } | null {
  const before = body.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && WORD.test(before[at - 1] ?? ' ')) return null;
  const query = before.slice(at + 1);
  if (query.includes('\n') || query.length > 40) return null;
  return { start: at, query };
}

export function suggestMembers(members: readonly Mentionable[], query: string, limit = 6): Mentionable[] {
  const wanted = fold(query.trim());
  return members.filter(member => !member.pending && (wanted === '' || fold(member.displayName).includes(wanted)))
    .sort((a, b) => Number(fold(b.displayName).startsWith(wanted)) - Number(fold(a.displayName).startsWith(wanted)) || a.displayName.localeCompare(b.displayName)).slice(0, limit);
}

/** Replaces the typed "@query" with "@Name " and returns the new text and caret. */
export function insertMention(body: string, start: number, caret: number, name: string): { body: string; caret: number } {
  const inserted = `@${name.trim()} `;
  return { body: body.slice(0, start) + inserted + body.slice(caret), caret: start + inserted.length };
}
