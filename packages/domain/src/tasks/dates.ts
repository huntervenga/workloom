import {sqlCalendarDateSchema,type TaskDto} from '@workloom/contracts';
import {DomainError} from '../errors.js';
/** Shared by ordinary task commands and atomic schedule batches; no timezone arithmetic. */
export function assertTaskDateRange(startDate:string|null|undefined,dueDate:string|null|undefined):void {
 for(const value of [startDate,dueDate])if(value!==null&&value!==undefined&&!sqlCalendarDateSchema.safeParse(value).success)throw new DomainError('DOMAIN_VALIDATION_FAILED','Dates must be real calendar dates in years 0001–9999.');
 if(startDate!==null&&startDate!==undefined&&dueDate!==null&&dueDate!==undefined&&startDate>dueDate)throw new DomainError('DOMAIN_VALIDATION_FAILED','Start date must be on or before due date.');
}
export function assertOrdinaryTaskDates(task:TaskDto,input:{startDate?:string|null|undefined;dueDate?:string|null|undefined}):void {
 if(task.meetingId&&(input.startDate!==undefined||input.dueDate!==undefined))throw new DomainError('DOMAIN_VALIDATION_FAILED','Use the guarded meeting calendar to change meeting dates.');
 assertTaskDateRange(input.startDate===undefined?task.startDate:input.startDate,input.dueDate===undefined?task.dueDate:input.dueDate);
}
