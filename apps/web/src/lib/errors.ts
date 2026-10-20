import { t } from '../i18n';
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
  | 'taskSave'
  | 'comments'
  | 'commentSave'
  | 'activity'
  | 'tablePreference'
  | 'tablePreferenceSave'
  | 'fields'
  | 'fieldSave'
  | 'columns'
  | 'columnsSave'
  | 'fieldValues'
  | 'fieldValueSave'
  | 'fieldHistory'
  | 'planning'
  | 'planSave'
  | 'timeOffPreview'
  | 'timeOffSave'
  | 'freeze'
  | 'factSave'
  | 'report'
  | 'workCategory'
  | 'workCategorySave'
  | 'recategorize'
  | 'workTypeReport'
  | 'taskTime';

export interface ErrorDescription {
  title: string;
  description: string;
  retryable: boolean;
  /** The object is missing or not visible; nothing about it may be shown. */
  unavailable: boolean;
  requestId: string | null;
}

const subjectTitles: Record<ErrorSubject, string> = {
  get identity() { return t('errors.subject.identity'); },
  get workspaces() { return t('errors.subject.workspaces'); },
  get workspace() { return t('errors.subject.workspace'); },
  get members() { return t('errors.subject.members'); },
  get actorSwitch() { return t('errors.subject.actorSwitch'); },
  get projects() { return t('errors.subject.projects'); },
  get project() { return t('errors.subject.project'); },
  get projectSave() { return t('errors.subject.projectSave'); },
  get sections() { return t('errors.subject.sections'); },
  get sectionSave() { return t('errors.subject.sectionSave'); },
  get statuses() { return t('errors.subject.statuses'); },
  get tags() { return t('errors.subject.tags'); },
  get tagSave() { return t('errors.subject.tagSave'); },
  get tasks() { return t('errors.subject.tasks'); },
  get task() { return t('errors.subject.task'); },
  get taskSave() { return t('errors.subject.taskSave'); },
  get comments() { return t('errors.subject.comments'); },
  get commentSave() { return t('errors.subject.commentSave'); },
  get activity() { return t('errors.subject.activity'); },
  get tablePreference() { return t('errors.subject.tablePreference'); },
  get tablePreferenceSave() { return t('errors.subject.tablePreferenceSave'); },
  get fields() { return t('errors.subject.fields'); },
  get fieldSave() { return t('errors.subject.fieldSave'); },
  get columns() { return t('errors.subject.columns'); },
  get columnsSave() { return t('errors.subject.columnsSave'); },
  get fieldValues() { return t('errors.subject.fieldValues'); },
  get fieldValueSave() { return t('errors.subject.fieldValueSave'); },
  get fieldHistory() { return t('errors.subject.fieldHistory'); },
  get planning() { return t('errors.subject.planning'); },
  get planSave() { return t('errors.subject.planSave'); },
  get timeOffPreview() { return t('errors.subject.timeOffPreview'); },
  get timeOffSave() { return t('errors.subject.timeOffSave'); },
  get freeze() { return t('errors.subject.freeze'); },
  get factSave() { return t('errors.subject.factSave'); },
  get report() { return t('errors.subject.report'); },
  get workCategory() { return t('errors.subject.workCategory'); },
  get workCategorySave() { return t('errors.subject.workCategorySave'); },
  get recategorize() { return t('errors.subject.recategorize'); },
  get workTypeReport() { return t('errors.subject.workTypeReport'); },
  get taskTime() { return t('errors.subject.taskTime'); },
};

const kindDescriptions: Record<ApiErrorKind, string> = {
  get network() { return t('errors.kind.network'); },
  get unauthenticated() { return t('errors.kind.unauthenticated'); },
  get forbidden() { return t('errors.kind.forbidden'); },
  get not_found() { return t('errors.kind.not_found'); },
  get validation() { return t('errors.kind.validation'); },
  get conflict() { return t('errors.kind.conflict'); },
  get rate_limited() { return t('errors.kind.rate_limited'); },
  get unavailable() { return t('errors.kind.unavailable'); },
  get server() { return t('errors.kind.server'); },
  get invalid_response() { return t('errors.kind.invalid_response'); },
  get invalid_input() { return t('errors.kind.invalid_input'); },
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
const taskUnavailableCopy = {
  get title() { return t('errors.hidden.task.title'); },
  get description() { return t('errors.hidden.task.description'); },
};
const unavailableCopy: Partial<Record<ErrorSubject, { title: string; description: string }>> = {
  tablePreference: {
    get title() { return t('errors.hidden.project.title'); },
    get description() { return t('errors.hidden.project.description'); },
  },
  tablePreferenceSave: {
    get title() { return t('errors.hidden.project.title'); },
    get description() { return t('errors.hidden.project.description'); },
  },
  comments: taskUnavailableCopy,
  activity: taskUnavailableCopy,
  commentSave: taskUnavailableCopy,
  workspace: {
    get title() { return t('errors.hidden.workspace.title'); },
    get description() { return t('errors.hidden.workspace.description'); },
  },
  project: {
    get title() { return t('errors.hidden.project.title'); },
    get description() { return t('errors.hidden.project.description'); },
  },
  task: {
    get title() { return t('errors.hidden.task.title'); },
    get description() { return t('errors.hidden.task.description'); },
  },
};

/**
 * Writes. The form keeps the user's input, so the copy says what to do with it;
 * a conflict needs fresh data first, so resubmitting as is is not offered.
 */
const saveSubjects: ReadonlySet<ErrorSubject> = new Set([
  'projectSave',
  'sectionSave',
  'tagSave',
  'taskSave',
  'commentSave',
  'tablePreferenceSave',
  'fieldSave',
  'columnsSave',
  'fieldValueSave',
  'planSave',
  'timeOffPreview',
  'timeOffSave',
  'freeze',
  'factSave',
  'workCategorySave',
  'recategorize',
]);

/** A value write to a locked field; reloading and resending would be refused again. */
const fieldLockedDescription = () => t('errors.fieldLocked');

const saveDescriptions: Partial<Record<ApiErrorKind, string>> = {
  get network() { return t('errors.save.network'); },
  get forbidden() { return t('errors.save.forbidden'); },
  get not_found() { return t('errors.save.not_found'); },
  get validation() { return t('errors.save.validation'); },
  get conflict() { return t('errors.save.conflict'); },
  get invalid_input() { return t('errors.save.invalid_input'); },
};

/** Maps an error to fixed, user-safe copy. Server-provided text is never used. */
export function describeError(error: unknown, subject: ErrorSubject): ErrorDescription {
  if (!(error instanceof ApiError)) {
    return {
      title: subjectTitles[subject],
      description: t('errors.unexpected'),
      retryable: true,
      unavailable: false,
      requestId: null,
    };
  }

  const hidden = unavailableCopy[subject];
  if (hidden && (error.kind === 'forbidden' || error.kind === 'not_found' || error.kind === 'validation')) {
    return { ...hidden, retryable: false, unavailable: true, requestId: error.requestId };
  }

  if (error.code === 'DEPENDENCY_CYCLE') {
    return { title: t('errors.dependencyCycleTitle'), description: t('errors.dependencyCycleDescription'), retryable: false, unavailable: false, requestId: error.requestId };
  }

  if (error.kind === 'conflict' && error.code === 'PREVIEW_STALE') {
    return { title: subjectTitles[subject], description: t('errors.previewStale'), retryable: false, unavailable: false, requestId: error.requestId };
  }

  if (error.kind === 'conflict' && error.code === 'FIELD_LOCKED') {
    return {
      title: subjectTitles[subject],
      description: subject === 'planSave' ? t('errors.planLocked') : fieldLockedDescription(),
      retryable: false,
      unavailable: false,
      requestId: error.requestId,
    };
  }

  if(error.kind==='validation'&&error.completionFieldsRequired)return{title:t('errors.completionFieldsRequiredTitle'),description:t('errors.completionFieldsRequired'),retryable:false,unavailable:false,requestId:error.requestId};

  const isSave = saveSubjects.has(subject);
  return {
    title: subjectTitles[subject],
    description: (isSave ? saveDescriptions[error.kind] : undefined) ?? kindDescriptions[error.kind],
    retryable: retryableKinds.has(error.kind) && !(isSave && error.kind === 'conflict'),
    unavailable: false,
    requestId: error.requestId,
  };
}
