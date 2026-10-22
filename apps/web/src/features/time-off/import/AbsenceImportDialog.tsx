import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import type { LeaveOverviewDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useTranslation } from '../../../i18n';
import { ApiError, sendMutation } from '../../../lib/api';
import { describeError } from '../../../lib/errors';
import { DialogShell } from '../../../shared/DialogShell';
import { bulkRequest, previewBulk } from '../api';
import { timeOffKeys } from '../queries';
import { parseCsv } from './csv';
import { nameKey, readAbsenceTable, resolveAbsences, unmatchedNames, type ResolvedAbsence, type RowIssue } from './absenceRows';

type Outcome = { state: 'done' } | { state: 'failed'; message: string };

export function AbsenceImportDialog({ actorId, workspaceId, overview }: { actorId: string; workspaceId: string; overview: LeaveOverviewDto }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!overview.capabilities.canManage || !overview.settings) return null;
  return <>
    <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><FileUp size={16} aria-hidden="true" />{t('absenceImport.open')}</Button>
    {open ? <Importer actorId={actorId} workspaceId={workspaceId} overview={overview} onClose={() => setOpen(false)} /> : null}
  </>;
}

function Importer({ actorId, workspaceId, overview, onClose }: { actorId: string; workspaceId: string; overview: LeaveOverviewDto; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [grid, setGrid] = useState<string[][] | null>(null);
  const [readError, setReadError] = useState(false);
  const [overrides, setOverrides] = useState<{ people: Record<string, string>; types: Record<string, string> }>({ people: {}, types: {} });
  const [reason, setReason] = useState(t('absenceImport.defaultReason'));
  const [outcomes, setOutcomes] = useState<Record<number, Outcome>>({});
  const [running, setRunning] = useState(false);
  const keys = useRef(new Map<number, string>());

  const table = grid ? readAbsenceTable(grid) : null;
  const rows = table ? resolveAbsences(table.rows, overview, overrides) : [];
  const unmatched = unmatchedNames(rows);
  const ready = rows.filter(row => row.status === 'ready' && outcomes[row.line]?.state !== 'done');
  const finished = rows.filter(row => outcomes[row.line]?.state === 'done').length;
  const types = [...new Map(overview.settings?.policyVersions.flatMap(version => version.types.map(type => [type.id, type] as const)) ?? []).values()].filter(type => !type.archived);

  async function readFile(file: File) {
    setReadError(false); setOutcomes({}); setOverrides({ people: {}, types: {} });
    try { setGrid(parseCsv(await file.text())); } catch { setGrid(null); setReadError(true); }
  }

  async function importRow(row: ResolvedAbsence): Promise<Outcome> {
    if (row.membershipId === null || row.typeId === null || row.startDate === null || row.endDate === null) return { state: 'failed', message: '' };
    const input = { membershipIds: [row.membershipId], typeId: row.typeId, startDate: row.startDate, endDate: row.endDate, note: row.note, reason: reason.trim(), approveNegative: false };
    try {
      const preview = await previewBulk(workspaceId, input);
      const negative = preview.previews.some(item => item.preview.deficits.some(deficit => deficit.negativeApprovalRequired));
      const key = keys.current.get(row.line) ?? crypto.randomUUID();
      keys.current.set(row.line, key);
      await sendMutation(bulkRequest(workspaceId, { ...input, approveNegative: negative, expectedSourceVersion: preview.sourceVersion }), { idempotencyKey: key });
      return { state: 'done' };
    } catch (error) {
      if (error instanceof ApiError && (error.kind === 'unauthenticated' || error.kind === 'forbidden')) throw error;
      return { state: 'failed', message: describeError(error, 'timeOffSave').description };
    }
  }

  async function run() {
    if (running || ready.length === 0 || reason.trim() === '') return;
    setRunning(true);
    try {
      for (const row of ready) {
        const outcome = await importRow(row);
        setOutcomes(current => ({ ...current, [row.line]: outcome }));
      }
    } catch { /* access changed: the rows left stay ready and nothing else is sent */ }
    finally { setRunning(false); void client.invalidateQueries({ queryKey: timeOffKeys.root(actorId, workspaceId) }); }
  }

  const issueText = (issue: RowIssue) => issue === 'person' ? t('absenceImport.issue.person') : issue === 'type' ? t('absenceImport.issue.type') : issue === 'startDate' ? t('absenceImport.issue.startDate') : issue === 'endDate' ? t('absenceImport.issue.endDate') : issue === 'order' ? t('absenceImport.issue.order') : issue === 'duplicate' ? t('absenceImport.issue.duplicate') : t('absenceImport.issue.columns');
  const rowState = (row: ResolvedAbsence) => {
    const outcome = outcomes[row.line];
    if (outcome?.state === 'done') return t('absenceImport.state.done');
    if (outcome?.state === 'failed') return outcome.message || t('absenceImport.state.failed');
    return row.status === 'exists' ? t('absenceImport.state.exists') : row.status === 'ready' ? t('absenceImport.state.ready') : row.issues.map(issueText).join(', ');
  };
  const selectClass = 'h-8 rounded-md border border-line bg-surface px-2 text-sm text-ink';

  return <DialogShell open variant="wide" onOpenChange={next => { if (!next && !running) onClose(); }} title={t('absenceImport.title')} description={t('absenceImport.description')}>
    <div className="space-y-4">
      <div className="space-y-2 text-sm">
        <p>{t('absenceImport.format')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:bg-canvas">{t('absenceImport.choose')}
            <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" aria-label={t('absenceImport.file')} disabled={running} onChange={event => { const file = event.target.files?.[0]; if (file) void readFile(file); event.target.value = ''; }} />
          </label>
          <a className="text-xs text-accent-ink underline" download="absences-template.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(t('absenceImport.templateCsv'))}`}>{t('absenceImport.template')}</a>
        </div>
        {readError ? <p role="alert" className="text-danger">{t('absenceImport.readError')}</p> : null}
        {table && table.missingColumns.length > 0 ? <p role="alert" className="text-danger">{t('absenceImport.missingColumns', { columns: table.missingColumns.map(key => key === 'person' ? t('absenceImport.col.person') : key === 'type' ? t('absenceImport.col.type') : key === 'start' ? t('absenceImport.col.start') : t('absenceImport.col.end')).join(', ') })}</p> : null}
      </div>

      {table && rows.length > 0 ? <>
        {unmatched.people.length + unmatched.types.length > 0 ? <section aria-label={t('absenceImport.matchTitle')} className="space-y-2 rounded-lg border border-line p-3">
          <h3 className="text-sm font-medium">{t('absenceImport.matchTitle')}</h3>
          <p className="text-xs text-muted">{t('absenceImport.matchHelp')}</p>
          {unmatched.people.map(name => <label key={`p:${name}`} className="grid gap-1 text-xs text-muted sm:grid-cols-[1fr_1fr] sm:items-center">{t('absenceImport.matchPerson', { name })}
            <select className={selectClass} value={overrides.people[nameKey(name)] ?? ''} disabled={running} onChange={event => setOverrides(current => ({ ...current, people: { ...current.people, [nameKey(name)]: event.target.value } }))}>
              <option value="">{t('absenceImport.skipRows')}</option>
              {overview.members.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}
            </select></label>)}
          {unmatched.types.map(name => <label key={`t:${name}`} className="grid gap-1 text-xs text-muted sm:grid-cols-[1fr_1fr] sm:items-center">{t('absenceImport.matchType', { name })}
            <select className={selectClass} value={overrides.types[nameKey(name)] ?? ''} disabled={running} onChange={event => setOverrides(current => ({ ...current, types: { ...current.types, [nameKey(name)]: event.target.value } }))}>
              <option value="">{t('absenceImport.skipRows')}</option>
              {types.map(type => <option key={type.id} value={type.id}>{type.name}</option>)}
            </select></label>)}
        </section> : null}

        <p role="status" className="text-sm">{t('absenceImport.summary', { ready: rows.filter(row => row.status === 'ready').length, exists: rows.filter(row => row.status === 'exists').length, invalid: rows.filter(row => row.status === 'invalid').length })}{finished > 0 ? ` ${t('absenceImport.progress', { done: finished })}` : ''}</p>
        <div className="max-h-72 overflow-auto rounded-lg border border-line">
          <table className="w-full min-w-[34rem] text-xs">
            <thead className="sticky top-0 bg-canvas text-muted"><tr>{[t('absenceImport.col.line'), t('absenceImport.col.person'), t('absenceImport.col.type'), t('absenceImport.col.dates'), t('absenceImport.col.result')].map(label => <th key={label} scope="col" className="px-2 py-1 text-left font-medium">{label}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">{rows.map(row => <tr key={row.line} data-row-status={outcomes[row.line]?.state ?? row.status}>
              <td className="px-2 py-1 tabular-nums text-muted">{row.line}</td><td className="px-2 py-1">{row.person}</td><td className="px-2 py-1">{row.type}</td>
              <td className="px-2 py-1 tabular-nums">{row.startDate ?? '—'} → {row.endDate ?? '—'}</td><td className="px-2 py-1">{rowState(row)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <label className="grid gap-1 text-xs text-muted">{t('absenceImport.reason')}<TextInput maxLength={2000} value={reason} disabled={running} onChange={event => setReason(event.target.value)} /></label>
        <p className="text-xs text-muted">{t('absenceImport.note')}</p>
      </> : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" disabled={running} onClick={onClose}>{t('absenceImport.close')}</Button>
        <Button variant="primary" disabled={running || ready.length === 0 || reason.trim() === ''} onClick={() => void run()}>{running ? t('absenceImport.importing') : t('absenceImport.import', { count: ready.length })}</Button>
      </div>
    </div>
  </DialogShell>;
}
