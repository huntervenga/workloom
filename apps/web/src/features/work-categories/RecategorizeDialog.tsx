import type { CategorizedWorkLogDto, ProjectWorkCategoryBindingDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { Button, TextInput, inputClassName } from '@workloom/ui';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { CategoryBadge } from './CategoryBadge';
import type { WorkCategoryCommands } from './queries';

export interface RecategorizeSession {
  key: string;
  log: CategorizedWorkLogDto;
  binding: ProjectWorkCategoryBindingDto;
  taskTitle: string;
  memberName: string;
  optionId: string;
  reason: string;
  stale: boolean;
}
export function recategorizeSession(log: CategorizedWorkLogDto, binding: ProjectWorkCategoryBindingDto, taskTitle: string, memberName: string): RecategorizeSession {
  return { key: log.id, log, binding, taskTitle, memberName, optionId: log.category.kind === 'categorized' && log.category.fieldId === binding.fieldId ? log.category.optionId : '', reason: '', stale: false };
}
interface Props {
  session: RecategorizeSession | null;
  open: boolean;
  field: TaskFieldDefinitionDto | null;
  writable: boolean;
  mutation: WorkCategoryCommands['recategorize'];
  onChange: (session: RecategorizeSession) => void;
  onClose: () => void;
  onSaved: (key: string) => void;
  onReload: (session: RecategorizeSession) => Promise<{ log: CategorizedWorkLogDto; binding: ProjectWorkCategoryBindingDto }>;
}

export function RecategorizeDialog(props: Props) {
  const id = useId();
  const [validation, setValidation] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { session, mutation } = props;
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  if (!session) return null;
  const heldHere = held?.workLogId === session.log.id ? held : null;
  const blocked = held !== null && heldHere === null;
  const shownOption = heldHere ? heldHere.input.optionId ?? '' : session.optionId;
  const shownReason = heldHere?.input.reason ?? session.reason;
  const available = props.field?.id === session.binding.fieldId && props.field.archivedAt === null && props.field.type === 'single_select';
  const options = available ? props.field?.options.filter((option) => option.archivedAt === null) ?? [] : [];
  const ownError = mutation.variables?.workLogId === session.log.id ? mutation.error : null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!props.writable || mutation.pendingCommand || blocked) return;
    if (heldHere && mutation.uncertain) { mutation.retryUncertain({ onSuccess: () => props.onSaved(session.key) }); return; }
    if (session.stale || session.log.state !== 'active') return;
    const previous = session.log.category;
    const unchanged = shownOption ? previous.kind === 'categorized' && previous.fieldId === session.binding.fieldId && previous.optionId === shownOption : previous.kind === 'uncategorized';
    if (unchanged) { setNotice('Категория не изменилась. Запись остаётся прежней.'); return; }
    if (!session.reason.trim()) { setValidation('Укажите причину изменения типа работы.'); return; }
    if (shownOption && !options.some((option) => option.id === shownOption)) { setValidation('Выберите действующий вариант текущего поля или «Без категории».'); return; }
    setValidation(null); setNotice(null);
    mutation.mutate({ workLogId: session.log.id, periodId: session.log.periodId, input: { expectedWorkLogRevision: session.log.revision, expectedBindingRevision: session.binding.revision, optionId: shownOption || null, reason: session.reason.trim() } }, { onSuccess: () => props.onSaved(session.key), onError: (failure) => { if (failure instanceof ApiError && failure.kind === 'conflict') props.onChange({ ...session, stale: true }); } });
  };
  const reload = async () => {
    if (held || reloading) return;
    setReloading(true); setNotice(null);
    try { const fresh = await props.onReload(session); props.onChange({ ...session, log: fresh.log, binding: fresh.binding, stale: false }); mutation.reset(); setNotice('Загружена актуальная запись. Ваш выбор и причина сохранены — проверьте их перед отправкой.'); }
    catch { setNotice('Не удалось обновить запись. Введённые данные сохранены.'); }
    finally { setReloading(false); }
  };
  return <DialogShell title="Изменить тип записанной работы" description={`${session.taskTitle} · ${session.memberName}. Меняется категория этой записи ${session.log.sourceKind==='manual_period'?'за неделю':'присутствия'}, часы сохраняются.`} open={props.open} onOpenChange={(next) => { if (!next) props.onClose(); }}>
    <form className="mt-5 space-y-4" onSubmit={submit}>
      <div className="space-y-1"><p className="text-xs text-muted">Сохранённый тип этой записи</p><CategoryBadge category={session.log.category} /></div>
      {session.log.state === 'void' ? <p className="text-sm text-muted">Запись отменена. Сначала явно восстановите её через изменение факта.</p> : null}
      {blocked ? <p role="status" className="text-sm text-amber-800">Другое изменение категории ещё не подтверждено. Сначала разрешите его отправку.</p> : null}
      <fieldset disabled={!props.writable || held !== null || session.log.state !== 'active'} className="min-w-0 space-y-4">
        <div className="space-y-1.5"><label htmlFor={`${id}-option`} className="text-sm font-medium">Новый тип работы</label><select id={`${id}-option`} className={inputClassName()} value={shownOption} onChange={(event) => { props.onChange({ ...session, optionId: event.target.value }); setValidation(null); setNotice(null); }}><option value="">Без категории</option>{options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}{shownOption && !options.some((option) => option.id === shownOption) ? <option value={shownOption} disabled>{session.log.category.kind === 'categorized' ? session.log.category.optionLabel : 'Сохранённый вариант'} · недоступен для нового выбора</option> : null}</select>{!available ? <p className="text-xs text-muted">Действующее поле типа работы не выбрано. Можно явно снять категорию.</p> : null}</div>
        <div className="space-y-1.5"><label htmlFor={`${id}-reason`} className="text-sm font-medium">Причина изменения типа работы</label><TextInput id={`${id}-reason`} value={shownReason} onChange={(event) => props.onChange({ ...session, reason: event.target.value })} maxLength={1000} /></div>
      </fieldset>
      {validation ? <p role="alert" className="text-sm text-red-700">{validation}</p> : null}
      <SaveFeedback subject="recategorize" error={ownError} uncertainError={heldHere ? mutation.uncertain?.error ?? null : null} action={session.stale ? <Button size="sm" disabled={reloading} onClick={() => void reload()}>Загрузить актуальную запись и настройку</Button> : null} />
      {notice ? <p role="status" className="text-sm text-muted">{notice}</p> : null}
      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4"><Button onClick={props.onClose}>Закрыть</Button>{props.writable ? <Button type="submit" variant="primary" disabled={mutation.pendingCommand !== null || blocked || session.stale || session.log.state !== 'active'}>{heldHere ? mutation.pendingCommand ? 'Отправляем…' : 'Повторить отправку' : 'Сохранить новый тип работы'}</Button> : null}</div>
    </form>
  </DialogShell>;
}
