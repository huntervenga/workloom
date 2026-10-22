import { describe, expect, it } from 'vitest';
import { generateApiToken, parseApiToken } from './tokens.js';
import { matchRefs, resolveRef, resolveRefs } from './refs.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const items = [{ id: id(1), name: 'To do' }, { id: id(2), name: 'In  Progress' }, { id: id(3), name: 'Done' }, { id: id(4), name: 'done' }];

describe('reference resolution', () => {
  it('matches a UUID or a name ignoring case and repeated spaces', () => {
    expect(resolveRef('status', id(1), items).name).toBe('To do');
    expect(resolveRef('status', ' in progress ', items).id).toBe(id(2));
  });
  it('reports unknown and ambiguous names with candidates', () => {
    expect(() => resolveRef('status', 'Blocked', items)).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED', details: expect.objectContaining({ reason: 'not_found', field: 'status' }) }));
    expect(() => resolveRef('status', 'DONE', items)).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'ambiguous' }) }));
  });
  it('de-duplicates lists and lets filters keep every same-named match', () => {
    expect(resolveRefs('status', ['to do', id(1)], items)).toHaveLength(1);
    expect(matchRefs('status', ['done'], items).map(item => item.id)).toEqual([id(3), id(4)]);
  });
});

describe('token format', () => {
  it('generates a prefixed secret whose hash is what parsing yields', () => {
    const { token, hash, prefix } = generateApiToken();
    expect(token).toMatch(/^wlm_pat_[A-Za-z0-9_-]{43}$/);
    expect(parseApiToken(token)).toBe(hash);
    expect(prefix).toBe(token.slice(0, 12));
  });
  it.each(['', 'wlm_pat_', 'Bearer x', `wlm_pat_${'a'.repeat(42)}`, `wlm_pat_${'a'.repeat(44)}`, ` wlm_pat_${'a'.repeat(43)}`])('rejects %j', value => {
    expect(() => parseApiToken(value)).toThrowError(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });
});
