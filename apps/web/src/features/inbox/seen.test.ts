import type { InboxItemDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { unreadItems } from './seen';

const item = (id: string, at: string) => ({ id, at }) as unknown as InboxItemDto;

describe('what counts as unread', () => {
  const items = [item('a', '2026-10-22T12:00:00.000Z'), item('b', '2026-10-22T08:00:00.000Z'), item('c', '2026-10-01T08:00:00.000Z')];
  it('is everything newer than the bookmark', () => expect(unreadItems(items, '2026-10-22T09:00:00.000Z').map(i => i.id)).toEqual(['a']));
  it('on a first visit counts only the last day', () => expect(unreadItems(items, null, new Date('2026-10-22T13:00:00.000Z')).map(i => i.id)).toEqual(['a', 'b']));
});
