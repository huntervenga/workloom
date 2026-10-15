import { ApiError, type ApiErrorKind } from './api';

export type ErrorSubject =
  | 'identity'
  | 'workspaces'
  | 'workspace'
  | 'members'
  | 'actorSwitch'
  | 'projects'
  | 'project'
  | 'projectSave'
  | 'sections'
  | 'sectionSave'
  | 'statuses'
  | 'tags'
  | 'tagSave'
  | 'tasks'
  | 'task'
  | 'taskSave';

export interface ErrorDescription {
  title: string;
  description: string;
  retryable: boolean;
  /** The object is missing or not visible; nothing about it may be shown. */
  unavailable: boolean;
  requestId: string | null;
}

const subjectTitles: Record<ErrorSubject, string> = {
  identity: 'Не удалось определить пользователя',
  workspaces: 'Не удалось загрузить пространства',
  workspace: 'Не удалось открыть пространство',
  members: 'Не удалось загрузить участников',
  actorSwitch: 'Не удалось сменить тестового пользователя',
  projects: 'Не удалось загрузить проекты',
  project: 'Не удалось открыть проект',
  projectSave: 'Не удалось сохранить проект',
  sections: 'Не удалось загрузить секции',
  sectionSave: 'Не удалось сохранить раздел',
  statuses: 'Не удалось загрузить статусы',
  tags: 'Не удалось загрузить теги',
  tagSave: 'Не удалось сохранить тег',
  tasks: 'Не удалось загрузить задачи',
  task: 'Не удалось открыть задачу',
  taskSave: 'Не удалось сохранить задачу',
};

const kindDescriptions: Record<ApiErrorKind, string> = {
  network: 'Нет связи с сервером. Проверьте, что локальный сервер запущен, и повторите попытку.',
  unauthenticated: 'Сервер не определил текущего пользователя. Повторите попытку или перезапустите локальный сервер.',
  forbidden: 'У текущего пользователя нет доступа к этим данным.',
  not_found: 'Данные не найдены или недоступны текущему пользователю.',
  validation: 'Сервер отклонил запрос.',
  conflict: 'Данные успели измениться. Повторите попытку.',
  rate_limited: 'Слишком много запросов. Подождите немного и повторите.',
  unavailable: 'Сервис временно недоступен. Повторите попытку чуть позже.',
  server: 'На сервере произошла ошибка. Повторите попытку позже.',
  invalid_response: 'Сервер вернул ответ в неожиданном формате.',
  invalid_input: 'Данные не прошли проверку и не были отправлены.',
};

const retryableKinds: ReadonlySet<ApiErrorKind> = new Set([
  'network',
  'unauthenticated',
  'conflict',
  'rate_limited',
  'unavailable',
  'server',
  'invalid_response',
]);

/** Objects whose denial and absence look the same, so their existence is not revealed. */
const unavailableCopy: Partial<Record<ErrorSubject, { title: string; description: string }>> = {
  workspace: {
    title: 'Пространство недоступно',
    description: 'Такого пространства нет или у текущего пользователя нет к нему доступа.',
  },
  project: {
    title: 'Проект недоступен',
    description: 'Такого проекта нет или у текущего пользователя нет к нему доступа.',
  },
  task: {
    title: 'Задача недоступна',
    description: 'Такой задачи нет или у текущего пользователя нет к ней доступа.',
  },
};

/**
 * Writes. The form keeps the user's input, so the copy says what to do with it;
 * a conflict needs fresh data first, so resubmitting as is is not offered.
 */
const saveSubjects: ReadonlySet<ErrorSubject> = new Set(['projectSave', 'sectionSave', 'tagSave', 'taskSave']);

const saveDescriptions: Partial<Record<ApiErrorKind, string>> = {
  network: 'Нет связи с сервером. Введённые данные остались в форме — отправьте их ещё раз.',
  forbidden: 'У вашей роли нет прав на это изменение.',
  not_found: 'Объект не найден или больше недоступен текущему пользователю.',
  validation: 'Сервер не принял данные. Проверьте поля и попробуйте снова.',
  conflict: 'Данные успели измениться в другом месте. Загрузите актуальную версию и сохраните снова.',
  invalid_input: 'Проверьте заполненные поля.',
};

/** Maps an error to fixed, user-safe copy. Server-provided text is never used. */
export function describeError(error: unknown, subject: ErrorSubject): ErrorDescription {
  if (!(error instanceof ApiError)) {
    return {
      title: subjectTitles[subject],
      description: 'Произошла непредвиденная ошибка. Повторите попытку.',
      retryable: true,
      unavailable: false,
      requestId: null,
    };
  }

  const hidden = unavailableCopy[subject];
  if (hidden && (error.kind === 'forbidden' || error.kind === 'not_found' || error.kind === 'validation')) {
    return { ...hidden, retryable: false, unavailable: true, requestId: error.requestId };
  }

  const isSave = saveSubjects.has(subject);
  return {
    title: subjectTitles[subject],
    description: (isSave ? saveDescriptions[error.kind] : undefined) ?? kindDescriptions[error.kind],
    retryable: retryableKinds.has(error.kind) && !(isSave && error.kind === 'conflict'),
    unavailable: false,
    requestId: error.requestId,
  };
}
