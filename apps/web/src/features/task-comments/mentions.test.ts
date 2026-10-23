import { describe, expect, it } from 'vitest';
import { findMentions, insertMention, mentionQueryAt, suggestMembers } from './mentions';

const members = [{ id: 'a', displayName: 'Ann' }, { id: 'b', displayName: 'Ann Lee' }, { id: 'c', displayName: 'Борис Петров' }, { id: 'd', displayName: 'Pending Pat', pending: true }];

describe('mentions', () => {
  it('finds whole names only, longest first, and ignores pending people', () => {
    expect(findMentions('Hi @Ann Lee, and @ann!', members).sort()).toEqual(['a', 'b']);
    expect(findMentions('@Annabel is not Ann', members)).toEqual([]);
    expect(findMentions('mail@Ann.com', members)).toEqual([]);
    expect(findMentions('@борис петров посмотри', members)).toEqual(['c']);
    expect(findMentions('@Pending Pat', members)).toEqual([]);
  });
  it('reads the query being typed before the caret', () => {
    expect(mentionQueryAt('Hello @an', 9)).toEqual({ start: 6, query: 'an' });
    expect(mentionQueryAt('Hello @an and more', 9)).toEqual({ start: 6, query: 'an' });
    expect(mentionQueryAt('a@b', 3)).toBeNull();
    expect(mentionQueryAt('@x\ny', 4)).toBeNull();
  });
  it('suggests by prefix first and inserts the name with a trailing space', () => {
    expect(suggestMembers(members, 'lee').map(m => m.id)).toEqual(['b']);
    expect(suggestMembers(members, 'an').map(m => m.id)).toEqual(['a', 'b']);
    expect(insertMention('Hello @an and', 6, 9, 'Ann Lee')).toEqual({ body: 'Hello @Ann Lee  and', caret: 15 });
  });
});
