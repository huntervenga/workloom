import { ApiError } from '../../lib/api';
import { t } from '../../i18n';
/** Only fixed localized text for a bounded server classification; never raw messages or details. */
export function duplicationErrorText(error:unknown):string {
 if(!(error instanceof ApiError))return t('duplication.previewFailed');
 if(error.kind==='forbidden'||error.kind==='unauthenticated'||error.code==='CAPABILITY_REQUIRED')return t('duplication.errors.permission');
 if(error.kind==='not_found')return t('duplication.errors.sourceUnavailable');
 if(error.code==='PREVIEW_STALE')return t('duplication.errors.stale');
 if(error.code==='FIELD_LOCKED')return t('duplication.errors.lockedField');
 switch(error.duplicationReason){
  case'meeting_or_unknown_task_type':case'meeting_parent_requires_added_scope':return t('duplication.errors.meeting');
  case'linked_task':return t('duplication.errors.linked');
  case'too_many_tasks':return t('duplication.errors.limit');
  case'source_project_too_large':return t('duplication.errors.projectLimit');
  case'field_unavailable':return t('duplication.errors.fieldUnavailable');
  case'attachment_storage_unavailable':return t('duplication.errors.attachmentStorage');
  case'todo_status_missing':return t('duplication.errors.todoMissing');
  case'archived_task':case'archived_source':return t('duplication.errors.archived');
  case'invalid_task_tree':return t('duplication.errors.hierarchy');
  case'section_order_full':return t('duplication.errors.sectionOrder');
  default:return t('duplication.previewFailed');
 }
}
