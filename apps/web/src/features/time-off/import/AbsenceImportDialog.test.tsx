import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { installFakeApi, ok, created, anna } from '../../../test/fakeApi';
import { renderFieldUi } from '../../fields/test/fixtures';
import { overview, prefix } from '../test/fixtures';
import { AbsenceImportDialog } from './AbsenceImportDialog';

const hex = (digit: string) => digit.repeat(64);
const preview = (membershipId: string) => ({ sourceVersion: hex('a'), previews: [{ membershipId, preview: { sourceVersion: hex('b'), today: '2026-10-19', chargedDays: [], totalMicrodays: 0, unavailableMinutes: 0, overlappingRequestIds: [], pausesAccrual: false, balancesBefore: [], balancesAfter: [], deficits: [] } }] });

function open(csv: string, overrides: Partial<ReturnType<typeof overview>> = {}) {
  const data = overview();
  const bulkBodies: Record<string, unknown>[] = [];
  const keys: (string | null)[] = [];
  installFakeApi({
    [`POST ${prefix}/requests/bulk-preview`]: request => ok(preview((request.body as { membershipIds: string[] }).membershipIds[0] ?? '')),
    [`POST ${prefix}/requests/bulk`]: request => {
      bulkBodies.push(request.body as Record<string, unknown>); keys.push(request.headers.get('Idempotency-Key'));
      return created([]);
    },
  });
  const ui = renderFieldUi(<AbsenceImportDialog actorId={anna.id} workspaceId={data.settings?.workspaceId ?? ''} overview={{ ...data, ...overrides }} />);
  return { ui, data, bulkBodies, keys, csv };
}

async function choose(ui: ReturnType<typeof renderFieldUi>, csv: string) {
  await ui.user.click(screen.getByRole('button', { name: 'Import absences' }));
  const input = await screen.findByLabelText('CSV file with absences');
  const file = new File([csv], 'absences.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
  fireEvent.change(input, { target: { files: [file] } });
}

describe('absence import dialog', () => {
  it('previews the rows, lets the person match an unknown name, then records each row once', async () => {
    const data = overview();
    const [first, second] = data.members;
    const vacation = data.settings?.policyVersions[0]?.types[0];
    if (!first || !second || !vacation) throw new Error('fixture');
    const csv = `Person,Type,Start,End,Note\n${first.displayName},${vacation.name},2026-07-06,2026-07-10,Trip\nSasha,${vacation.name},2026-08-03,2026-08-03,\n${second.displayName},Nonsense,2026-09-01,2026-09-02,\n`;
    const { ui, bulkBodies, keys } = open(csv);
    await choose(ui, csv);
    expect(await screen.findByRole('status')).toHaveTextContent('1 ready to import, 0 already recorded, 2 need attention.');
    const match = screen.getByRole('region', { name: 'Match names' });
    await ui.user.selectOptions(within(match).getByLabelText(/Person “Sasha”/), second.id);
    await ui.user.selectOptions(within(match).getByLabelText(/Leave type “Nonsense”/), vacation.id);
    expect(screen.getByRole('status')).toHaveTextContent('3 ready to import');
    await ui.user.click(screen.getByRole('button', { name: 'Import 3 absence(s)' }));
    await waitFor(() => expect(bulkBodies).toHaveLength(3));
    expect(bulkBodies[0]).toMatchObject({ membershipIds: [first.id], typeId: vacation.id, startDate: '2026-07-06', endDate: '2026-07-10', note: 'Trip', reason: 'Imported from spreadsheet', approveNegative: false, expectedSourceVersion: hex('a') });
    expect(bulkBodies[1]).toMatchObject({ membershipIds: [second.id], startDate: '2026-08-03', endDate: '2026-08-03' });
    expect(new Set(keys).size).toBe(3);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('3 imported'));
    expect(screen.getAllByText('Imported')).toHaveLength(3);
  });

  it('is not offered to people who cannot manage time off', () => {
    const data = overview();
    open('', { capabilities: { ...data.capabilities, canManage: false } });
    expect(screen.queryByRole('button', { name: 'Import absences' })).not.toBeInTheDocument();
  });
});
