import type {AttendanceDto,AttendanceHistoryDto,MeetingDto,RecordedWorkLogDto} from '@workloom/contracts';
import type {Capability} from '../access/capabilities.js';
import type {CommandContext} from '../access/context.js';
import type {WorkCategoryResolver} from '../categories/ports.js';
import type {PlanningRepository,PlanningTools,PlanningWriteScope} from '../planning/ports.js';
export interface MeetingRepository {
 readonly planning:PlanningRepository;
 saveMeeting(row:MeetingDto,exists:boolean):Promise<void>;
 insertMeetingRevision(row:MeetingDto,actorUserId:string,changeSeq:bigint,id:string):Promise<void>;
 saveAttendance(row:AttendanceDto,projectId:string,exists:boolean):Promise<void>;
 insertAttendanceRevision(row:AttendanceHistoryDto,workspaceId:string):Promise<void>;
 listAttendanceHistory(workspaceId:string,attendanceId:string):Promise<AttendanceHistoryDto[]>;
 findWorkRevision(workspaceId:string,revisionId:string):Promise<RecordedWorkLogDto|null>;
}
export interface MeetingWriteScope extends PlanningWriteScope {readonly meetings:MeetingRepository;readonly categoryResolver:WorkCategoryResolver}
export interface MeetingUnitOfWork {
 run<T>(ctx:CommandContext,cap:Capability,work:(scope:MeetingWriteScope)=>Promise<T>):Promise<T>;
 read<T>(ctx:CommandContext,cap:Capability,work:(repo:MeetingRepository)=>Promise<T>):Promise<T>;
}
export interface MeetingApplicationDependencies {readonly writer:MeetingUnitOfWork;readonly tools:PlanningTools}
export type MeetingMutationCommand='meeting.create'|'meeting.update'|'meeting.attendance.confirm'|'meeting.plan.apply';
