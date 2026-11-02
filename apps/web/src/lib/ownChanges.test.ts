import { beforeEach, describe, expect, it } from 'vitest';
import { ownChangesCover, recordOwnChanges, resetOwnChangesForTests } from './ownChanges';

const WS = '22222222-2222-4222-8222-222222222222';
beforeEach(() => resetOwnChangesForTests());

describe('own change sequences', () => {
  it('covers a range only when every sequence in it is our own', () => {
    recordOwnChanges(`${WS}:11, ${WS}:12`);
    expect(ownChangesCover(WS, '10', '12')).toBe(true);
    expect(ownChangesCover(WS, '10', '13')).toBe(false);
    expect(ownChangesCover(WS, '9', '12')).toBe(false);
    expect(ownChangesCover(WS.toUpperCase(), '11', '12')).toBe(true);
  });
  it('ignores malformed headers and other workspaces, and an empty or reversed range is not covered', () => {
    recordOwnChanges(null); recordOwnChanges('nonsense'); recordOwnChanges(`${WS}:x1`);
    recordOwnChanges('33333333-3333-4333-8333-333333333333:5');
    expect(ownChangesCover(WS, '4', '5')).toBe(false);
    recordOwnChanges(`${WS}:5`);
    expect(ownChangesCover(WS, '5', '5')).toBe(false);
    expect(ownChangesCover(WS, '4', '5')).toBe(true);
  });
});
