import {and,asc,eq} from 'drizzle-orm';
import {notFoundError,type MeetingRepository} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {meetings,meetingRevisions,meetingAttendances,meetingAttendanceRevisions,workLogs,workLogRevisions} from '../schema.js';
import {createPlanningRepository,projectRecordedWork} from './planning-repository.js';
/** Persistence only: immutable source/tenant identities, current heads joined separately. */
export function createMeetingRepository(source:Database|WorkloomExecutor):MeetingRepository {
 const db=isDatabase(source)?source.db:source,planning=createPlanningRepository(source);
 return {
  planning,
  async saveMeeting(row,exists){const values={id:row.id,workspaceId:row.workspaceId,projectId:row.projectId,taskId:row.taskId,workPackageId:row.workPackageId,plannedPeriodId:row.plannedPeriodId,revision:row.revision,document:row};if(!exists){await db.insert(meetings).values(values);return;}const changed=await db.update(meetings).set({revision:row.revision,document:row}).where(and(eq(meetings.id,row.id),eq(meetings.workspaceId,row.workspaceId),eq(meetings.projectId,row.projectId),eq(meetings.taskId,row.taskId),eq(meetings.workPackageId,row.workPackageId),eq(meetings.plannedPeriodId,row.plannedPeriodId),eq(meetings.revision,row.revision-1))).returning({id:meetings.id});if(!changed.length)throw notFoundError();},
  async insertMeetingRevision(row,actorUserId,changeSeq,id){await db.insert(meetingRevisions).values({id,workspaceId:row.workspaceId,meetingId:row.id,revision:row.revision,document:row,actorUserId,changeSeq});},
  async saveAttendance(row,projectId,exists){const document={...row,workLog:null};const values={id:row.id,workspaceId:row.workspaceId,projectId,meetingId:row.meetingId,taskId:row.taskId,membershipId:row.membershipId,revision:row.revision,document};if(!exists){await db.insert(meetingAttendances).values(values);return;}const changed=await db.update(meetingAttendances).set({revision:row.revision,document}).where(and(eq(meetingAttendances.id,row.id),eq(meetingAttendances.workspaceId,row.workspaceId),eq(meetingAttendances.projectId,projectId),eq(meetingAttendances.meetingId,row.meetingId),eq(meetingAttendances.taskId,row.taskId),eq(meetingAttendances.membershipId,row.membershipId),eq(meetingAttendances.revision,row.revision-1))).returning({id:meetingAttendances.id});if(!changed.length)throw notFoundError();},
  async insertAttendanceRevision(row,workspaceId){await db.insert(meetingAttendanceRevisions).values({id:row.id,workspaceId,attendanceId:row.attendanceId,revision:row.revision,document:row});},
  async listAttendanceHistory(ws,attendanceId){return (await db.select({document:meetingAttendanceRevisions.document}).from(meetingAttendanceRevisions).where(and(eq(meetingAttendanceRevisions.workspaceId,ws),eq(meetingAttendanceRevisions.attendanceId,attendanceId))).orderBy(asc(meetingAttendanceRevisions.id))).map(r=>r.document);},
  async findWorkRevision(ws,revisionId){const [r]=await db.select({log:workLogs,version:workLogRevisions}).from(workLogRevisions).innerJoin(workLogs,and(eq(workLogs.workspaceId,workLogRevisions.workspaceId),eq(workLogs.id,workLogRevisions.workLogId))).where(and(eq(workLogRevisions.workspaceId,ws),eq(workLogRevisions.id,revisionId)));return r?projectRecordedWork(r.log,r.version):null;},
 };
}
