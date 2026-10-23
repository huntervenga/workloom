import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { installFakeApi, ok, created, failure, anna } from '../../../test/fakeApi';
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


  it('retains the exact committed-but-unknown row and key before importing any later rows', async () => {
    const data = overview();
    const person = data.members[0], type = data.settings?.policyVersions[0]?.types[0];
    if (!person || !type) throw new Error('fixture');
    const csv = `Person,Type,Start,End,Note\n${person.displayName},${type.name},2026-07-06,2026-07-06,First\n${person.displayName},${type.name},2026-07-07,2026-07-07,Second\n`;
    const sent: { body: unknown; key: string | null }[] = [];
    let previews = 0;
    installFakeApi({
      [`POST ${prefix}/requests/bulk-preview`]: () => { previews++; return ok({ ...preview(person.id), sourceVersion: hex(previews === 1 ? 'a' : 'c') }); },
      [`POST ${prefix}/requests/bulk`]: request => { sent.push({ body: request.body, key: request.headers.get('Idempotency-Key') }); return sent.length === 1 ? failure(503, 'UNAVAILABLE', 'Lost acknowledgement') : created([]); },
    });
    const ui = renderFieldUi(<AbsenceImportDialog actorId={anna.id} workspaceId={data.settings?.workspaceId ?? ''} overview={data}/>);
    await choose(ui, csv);
    await ui.user.click(await screen.findByRole('button', { name: 'Import 2 absence(s)' }));
    const retry = await screen.findByRole('button', { name: 'Retry exact import' });
    expect(sent).toHaveLength(1); expect(previews).toBe(1);
    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    expect(closeButtons.at(-1)).toBeDisabled();
    const dismiss = closeButtons[0]; if (!dismiss) throw new Error('Missing dialog close');
    await ui.user.click(dismiss);
    expect(screen.getByRole('button', { name: 'Retry exact import' })).toBeInTheDocument();
    expect(screen.getByLabelText('CSV file with absences')).toBeDisabled();
    expect(screen.getByLabelText('Reason recorded for past absences')).toBeDisabled();
    await ui.user.click(retry);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 imported'));
    expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]); expect(previews).toBe(1);
    await ui.user.click(screen.getByRole('button', { name: 'Import 1 absence(s)' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('2 imported'));
    expect(previews).toBe(2); expect(sent).toHaveLength(3);
    expect(sent[2]?.key).not.toBe(sent[0]?.key);
    expect(sent[2]?.body).toMatchObject({ startDate: '2026-07-07', expectedSourceVersion: hex('c') });
  });

  it('is not offered to people who cannot manage time off', () => {
    const data = overview();
    open('', { capabilities: { ...data.capabilities, canManage: false } });
    expect(screen.queryByRole('button', { name: 'Import absences' })).not.toBeInTheDocument();
  });
});
