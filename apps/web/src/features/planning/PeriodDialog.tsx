import type { TaskFieldDefinitionDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useId, useState, type FormEvent } from 'react';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import type { PlanningCommands } from './queries';
import { localDateTimeInput, parseLocalDateTime } from './dates';

interface Props {
  projectId: string;
  timezone: string;
  fields: readonly TaskFieldDefinitionDto[];
  mutation: PlanningCommands['createPeriod'];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (periodId: string) => void;
}

/** Always mounted by the weekly page: closing the dialog never forgets a sent create. */
export function PeriodDialog({ projectId, timezone, fields, mutation, open, onOpenChange, onCreated }: Props) {
  const id = useId();
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [zone, setZone] = useState(timezone);
  const [cutoff, setCutoff] = useState('');
  const [protectEstimate, setProtectEstimate] = useState(true);
  const [protectedFields, setProtectedFields] = useState<string[]>([]);
  const [validation, setValidation] = useState<string | null>(null);
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const shown = held?.input;
  const locked = held !== null;
  const saved = (period: { id: string }) => {
    setName(''); setStart(''); setCutoff(''); setProtectedFields([]);
    onCreated(period.id);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.pendingCommand) return;
    if (mutation.uncertain) { mutation.retryUncertain({ onSuccess: saved }); return; }
    if (!name.trim() || !start || !cutoff || !zone.trim()) { setValidation('Заполните название, начало недели, часовой пояс и срок фиксации.'); return; }
    const timestamp = parseLocalDateTime(cutoff);
    if (timestamp === null) { setValidation('Укажите существующие дату и время в часовом поясе браузера. При переходе на летнее время часть часов может отсутствовать.'); return; }
    setValidation(null);
    mutation.mutate({ input: { projectId, name: name.trim(), localStart: start, timezone: zone.trim(), cutoffAt: timestamp.toISOString(), protectEstimate, protectedFieldIds: protectedFields } }, {
      onSuccess: saved,
    });
  };
  return (
    <DialogShell title="Новый недельный период" description="Неделя длится семь календарных дней в выбранном часовом поясе." open={open} onOpenChange={onOpenChange}>
      <form className="mt-5 space-y-4" onSubmit={submit} noValidate>
        <fieldset disabled={locked} className="min-w-0 space-y-4">
          <div className="space-y-1.5"><label htmlFor={`${id}-name`} className="text-sm font-medium">Название периода</label><TextInput id={`${id}-name`} value={shown?.name ?? name} onChange={(event) => setName(event.target.value)} maxLength={160} /></div>
          <div className="space-y-1.5"><label htmlFor={`${id}-start`} className="text-sm font-medium">Первый день недели</label><TextInput id={`${id}-start`} type="date" value={shown?.localStart ?? start} onChange={(event) => setStart(event.target.value)} /></div>
          <div className="space-y-1.5"><label htmlFor={`${id}-zone`} className="text-sm font-medium">Часовой пояс периода</label><TextInput id={`${id}-zone`} value={shown?.timezone ?? zone} onChange={(event) => setZone(event.target.value)} /><p className="text-xs text-muted">Например, Europe/Nicosia. Даты недели сохраняются без сдвига в UTC.</p></div>
          <div className="space-y-1.5"><label htmlFor={`${id}-cutoff`} className="text-sm font-medium">Срок фиксации ({browserZone})</label><TextInput id={`${id}-cutoff`} type="datetime-local" value={shown ? localDateTimeInput(new Date(shown.cutoffAt)) : cutoff} onChange={(event) => setCutoff(event.target.value)} /><p className="text-xs text-muted">Время вводится в часовом поясе браузера {browserZone}. Часовой пояс периода выше задаёт границы недели. После срока сервер фиксирует исходный план перед следующим изменением.</p></div>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={shown?.protectEstimate ?? protectEstimate} onChange={(event) => setProtectEstimate(event.target.checked)} /><span>Защитить общую оценку задачи при фиксации</span></label>
          {fields.some((field) => field.archivedAt === null) ? <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Защитить значения полей при фиксации</legend>{fields.filter((field) => field.archivedAt === null).map((field) => <label key={field.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={(shown?.protectedFieldIds ?? protectedFields).includes(field.id)} onChange={(event) => setProtectedFields((before) => event.target.checked ? [...before, field.id] : before.filter((value) => value !== field.id))} />{field.name}</label>)}</fieldset> : null}
        </fieldset>
        {validation ? <p role="alert" className="text-sm text-red-700">{validation}</p> : null}
        <SaveFeedback subject="planSave" error={mutation.error} uncertainError={mutation.uncertain?.error ?? null} />
        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4"><Button onClick={() => onOpenChange(false)}>Закрыть</Button><Button type="submit" variant="primary" disabled={mutation.pendingCommand !== null}>{mutation.pendingCommand ? 'Создаём…' : mutation.uncertain ? 'Повторить отправку' : 'Создать период'}</Button></div>
      </form>
    </DialogShell>
  );
}
