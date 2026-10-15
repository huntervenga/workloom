import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProjectColumnsDto, TaskFieldDefinitionDto, TaskFieldType } from '@workloom/contracts';
import type { ReactElement } from 'react';
import { createQueryClient } from '../../../lib/queryClient';
import { alpha } from '../../../test/fakeApi';

export const PROJECT_ID = 'e0000000-0000-4000-8000-000000000001';
export const FIELD_ID = '90000000-0000-4000-8000-000000000001';
export const OTHER_FIELD_ID = '90000000-0000-4000-8000-000000000002';
export const OPTION_ID = '91000000-0000-4000-8000-000000000001';
export const STAMP = '2026-10-01T09:00:00.000Z';
export const fieldsPath = '/api/v1/workspaces/' + alpha.id + '/fields';
export const columnsPath = '/api/v1/workspaces/' + alpha.id + '/projects/' + PROJECT_ID + '/columns';

export function field(name = 'Заметка', type: TaskFieldType = 'text', id = FIELD_ID): TaskFieldDefinitionDto {
  return {
    id, workspaceId: alpha.id, projectId: PROJECT_ID, name, type, revision: 1,
    definitionVersionId: '92000000-0000-4000-8000-000000000001',
    historyEnabled: true, locked: false, archivedAt: null, options: [],
    createdAt: STAMP, updatedAt: STAMP,
  };
}

export function columns(fields: readonly TaskFieldDefinitionDto[], revision = 1): ProjectColumnsDto {
  return {
    workspaceId: alpha.id, projectId: PROJECT_ID, revision,
    columns: fields.map((item, position) => ({ fieldId: item.id, position, width: 160, visible: true })),
  };
}

export function heldResponse() {
  let lose: () => void = () => undefined;
  const promise = new Promise<Response>((_resolve, reject) => {
    lose = () => reject(new TypeError('Failed to fetch'));
  });
  return { promise, lose };
}

export function renderFieldUi(element: ReactElement, client: QueryClient = createQueryClient({ retry: false })) {
  const result = render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return { ...result, client, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}
