import { describe, expect, it, vi } from 'vitest';
import { fetchPlanningPeriods } from './api';
import { PERIOD_B, PROJECT_ID, period } from './test/fixtures';
import { alpha, json } from '../../test/fakeApi';

describe('weekly collection pagination', () => {
  it('follows the actual cursor while retaining project scope and exposes both complete pages', async () => {
    const urls: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      urls.push(url);
      return json(200, { data: [url.searchParams.has('cursor') ? period(PERIOD_B) : period()], meta: { requestId: 'req_paging', nextCursor: url.searchParams.has('cursor') ? null : 'opaque-next-page' } });
    }));
    const result = await fetchPlanningPeriods(alpha.id, PROJECT_ID);
    expect(result.map((item) => item.name)).toEqual(['Неделя А', 'Неделя Б']);
    expect(urls).toHaveLength(2);
    expect(urls[1]?.searchParams.get('cursor')).toBe('opaque-next-page');
    expect(urls.every((url) => url.searchParams.get('projectId') === PROJECT_ID)).toBe(true);
  });

  it('refuses a repeating cursor instead of hanging or presenting silently incomplete results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { data: [period()], meta: { requestId: 'req_paging', nextCursor: 'stuck' } })));
    await expect(fetchPlanningPeriods(alpha.id, PROJECT_ID)).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
