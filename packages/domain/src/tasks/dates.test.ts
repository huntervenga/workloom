import {describe,it,expect} from 'vitest';
import type {TaskDto} from '@workloom/contracts';
import {assertTaskDateRange,assertOrdinaryTaskDates} from './dates.js';
describe('shared final task dates',()=>{
 it('accepts partial dates and inclusive same-day ranges',()=>{for(const [a,b] of [[null,null],[null,'9999-12-31'],['0001-01-01',null],['2026-10-16','2026-10-16']])expect(()=>assertTaskDateRange(a,b)).not.toThrow();});
 it('checks partial updates against the current other endpoint',()=>{const task={startDate:'2026-10-16',dueDate:'2026-10-17',meetingId:null} as TaskDto;expect(()=>assertOrdinaryTaskDates(task,{startDate:'2026-10-18'})).toThrow('on or before');expect(()=>assertOrdinaryTaskDates(task,{dueDate:'2026-10-15'})).toThrow('on or before');expect(()=>assertOrdinaryTaskDates(task,{startDate:null})).not.toThrow();});
 it('rejects meeting calendar bypasses and unsupported dates',()=>{expect(()=>assertOrdinaryTaskDates({meetingId:'meeting'} as TaskDto,{startDate:null})).toThrow('guarded meeting');expect(()=>assertTaskDateRange('0000-01-01',null)).toThrow('0001');});
});
