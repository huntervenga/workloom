import { act, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi, ok } from '../../test/fakeApi';
import { queryKeys } from '../../lib/queryKeys';
import { renderFieldUi } from '../fields/test/fixtures';
import { useMembershipsQuery } from '../workspace/queries';
import { MentionTextarea } from './MentionTextarea';

function Example() {
  useMembershipsQuery(anna.id, alpha.id);
  const [text, setText] = useState('');
  return <MentionTextarea actorId={anna.id} workspaceId={alpha.id} aria-label="Comment" value={text} onValueChange={setText}/>;
}

describe('passive mention membership cache', () => {
  it('keeps the real membership fetcher during invalidation and observes the refreshed members', async () => {
    let reads = 0;
    installFakeApi({ [`GET /api/v1/workspaces/${alpha.id}/memberships`]: () => { reads++; return ok(alphaMembers); } });
    const ui = renderFieldUi(<Example/>);
    await waitFor(() => expect(ui.client.getQueryData(queryKeys.memberships(anna.id, alpha.id))).toEqual(alphaMembers));
    await ui.user.type(screen.getByLabelText('Comment'), '@Вер');
    expect(await screen.findByRole('option', { name: 'Вера Образцова' })).toBeInTheDocument();
    await act(async () => { await ui.client.invalidateQueries({ queryKey: queryKeys.memberships(anna.id, alpha.id) }); });
    expect(reads).toBe(2);
    expect(ui.client.getQueryData(queryKeys.memberships(anna.id, alpha.id))).toEqual(alphaMembers);
    expect(screen.getByRole('option', { name: 'Вера Образцова' })).toBeInTheDocument();
  });
});

it('inserts a selected task reference by stable URL', async () => {
  const target = {
    id: 'a0000000-0000-4000-8000-000000000001', title: 'Release checklist',
    projectId: 'a0000000-0000-4000-8000-000000000002', projectName: 'Operations', statusName: 'Done', statusGroup: 'done',
  };
  installFakeApi({
    [`GET /api/v1/workspaces/${alpha.id}/memberships`]: () => ok(alphaMembers),
    [`GET /api/v1/workspaces/${alpha.id}/task-search`]: () => ok([target]),
  });
  const ui = renderFieldUi(<Example />);
  const textarea = screen.getByLabelText('Comment');
  await ui.user.type(textarea, 'See @release');
  expect(await screen.findByRole('option', { name: /Release checklist.*Operations/ })).toBeInTheDocument();
  await ui.user.keyboard('{Enter}');
  expect(textarea).toHaveValue(`See ${window.location.origin}/app/w/${alpha.id}/projects/${target.projectId}?task=${target.id} `);
});
