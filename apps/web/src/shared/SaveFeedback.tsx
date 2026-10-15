import { CircleHelp, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { describeError, type ErrorSubject } from '../lib/errors';
import { PendingCommandError, UncertainCommandError } from '../lib/idempotency';

/** Fixed copy for a write refused on the client, before anything was sent. */
function refusedCopy(error: Error): string | null {
  if (error instanceof UncertainCommandError) {
    return 'Изменение не отправлено: результат предыдущей отправки ещё неизвестен. Сначала повторите её без изменений.';
  }
  if (error instanceof PendingCommandError) {
    return 'Изменение не отправлено: предыдущая отправка ещё ждёт ответа сервера. Дождитесь результата и повторите.';
  }
  return null;
}

export interface SaveErrorProps {
  error: Error;
  subject: ErrorSubject;
  /** Recovery action shown with the error, e.g. reloading after a conflict. */
  action?: ReactNode;
}

/** A confirmed save failure, in fixed copy; server text is never shown. */
export function SaveError({ error, subject, action }: SaveErrorProps) {
  const described = describeError(error, subject);
  const refused = refusedCopy(error);
  return (
    <div role="alert" className="flex gap-2.5 rounded-lg border border-red-200 bg-red-50/70 px-3 py-2.5 text-sm">
      <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-red-600" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-red-900">{described.title}</p>
        <p className="leading-relaxed text-red-800/90">{refused ?? described.description}</p>
        {described.requestId ? (
          <p className="text-xs text-red-800/70">
            Код запроса: <code className="font-mono">{described.requestId}</code>
          </p>
        ) : null}
        {action ? <div className="pt-1.5">{action}</div> : null}
      </div>
    </div>
  );
}

export interface UncertainCommandNoticeProps {
  /** Why the outcome is unknown (network, server, unavailable or a malformed answer). */
  error: Error;
  subject: ErrorSubject;
  /** A different command was just refused without being sent. */
  blocked?: boolean | undefined;
  action?: ReactNode;
}

/**
 * Shown while a sent write has no confirmed answer. The form keeps the sent data locked;
 * the only way forward is resending it unchanged, with the same Idempotency-Key.
 */
export function UncertainCommandNotice({ error, subject, blocked = false, action }: UncertainCommandNoticeProps) {
  const described = describeError(error, subject);
  return (
    <div role="alert" className="flex gap-2.5 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2.5 text-sm">
      <CircleHelp size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-amber-700" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-amber-950">{described.title}</p>
        <p className="leading-relaxed text-amber-900">{described.description}</p>
        <p className="leading-relaxed text-amber-900">
          Неизвестно, успел ли сервер сохранить изменение. Отправленные данные закреплены в форме до подтверждения:
          повторите отправку без изменений — повтор не создаст дубль. Форма сохранится, пока вы не уйдёте со страницы.
        </p>
        {blocked ? <p className="font-medium text-amber-950">Другие данные не отправлены.</p> : null}
        {described.requestId ? (
          <p className="text-xs text-amber-900/70">
            Код запроса: <code className="font-mono">{described.requestId}</code>
          </p>
        ) : null}
        {action ? <div className="pt-1.5">{action}</div> : null}
      </div>
    </div>
  );
}

export interface SaveFeedbackProps {
  /** Latest attempt's error, if any. */
  error: Error | null;
  /** The uncertain command's error, kept through `reset()`. */
  uncertainError: Error | null;
  subject: ErrorSubject;
  action?: ReactNode;
}

/** One alert at a time: an uncertain command outranks the latest error. */
export function SaveFeedback({ error, uncertainError, subject, action }: SaveFeedbackProps) {
  if (uncertainError) {
    return (
      <UncertainCommandNotice
        error={uncertainError}
        subject={subject}
        blocked={error instanceof UncertainCommandError || error instanceof PendingCommandError}
      />
    );
  }
  return error ? <SaveError error={error} subject={subject} action={action} /> : null;
}
