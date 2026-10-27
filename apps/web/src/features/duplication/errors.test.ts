import { describe, expect, it } from 'vitest';
import { ApiError, type DuplicationReason } from '../../lib/api';
import { duplicationErrorText } from './errors';
describe('actionable safe duplication errors',()=>{
 for(const[reason,copy]of[['meeting_or_unknown_task_type','Meetings'],['linked_task','home project'],['too_many_tasks','100 tasks'],['field_unavailable','Deselect'],['todo_status_missing','To do'],['attachment_storage_unavailable','File storage'],['archived_source','Restore'],['invalid_task_tree','hierarchy']] satisfies [DuplicationReason,string][])it(`explains ${reason} with fixed recovery copy`,()=>{expect(duplicationErrorText(new ApiError({kind:'validation',status:422,code:'DOMAIN_VALIDATION_FAILED',duplicationReason:reason}))).toContain(copy);});
 it('does not display arbitrary errors or server messages',()=>{expect(duplicationErrorText(new Error('postgres://secret:password@db'))).not.toMatch(/postgres|password|secret/);expect(duplicationErrorText(new ApiError({kind:'conflict',status:409,code:'PREVIEW_STALE'}))).toContain('Refresh');});
});
