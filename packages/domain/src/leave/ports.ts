import type * as C from '@workloom/contracts';
import type { Capability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import type { MembershipRecord } from '../access/ports.js';
import type { WorkspaceWriteScope } from '../transactions/ports.js';
export interface LeaveStoredSource {settings:C.LeaveSettingsDto|null;profiles:C.LeaveProfileDto[];requests:C.LeaveStoredRequestDto[];adjustments:C.LeaveAdjustmentDto[];members:MembershipRecord[];head:string}
export interface LeaveRepository {
 source():Promise<LeaveStoredSource>;
 isRealUser(userId:string):Promise<boolean>;
 saveSettings(value:C.LeaveSettingsDto,actor:string,reason:string,at:Date):Promise<void>;
 saveProfile(value:C.LeaveProfileDto,actor:string,reason:string,at:Date):Promise<void>;
 saveRequest(value:C.LeaveStoredRequestDto,before:C.LeaveStoredRequestDto|null,actor:string,reason:string,at:Date):Promise<void>;
 addAdjustment(value:C.LeaveAdjustmentDto,actor:string,at:Date):Promise<void>;
 receipt(actor:string,command:string,key:string):Promise<{payloadHash:string;result:unknown}|null>;
 saveReceipt(actor:string,command:string,key:string,payloadHash:string,result:unknown,at:Date):Promise<void>;
}
export interface LeaveScope extends WorkspaceWriteScope {repository:LeaveRepository}
export interface LeaveDependencies {
 read<T>(context:CommandContext,capability:Capability,work:(scope:LeaveScope)=>Promise<T>):Promise<T>;
 write<T>(context:CommandContext,capability:Capability,work:(scope:LeaveScope)=>Promise<T>):Promise<T>;
 newId():string;digest(value:string):string;
}
export interface LeaveApplication {
 previewHistory(context:CommandContext,input:C.PreviewLeaveHistoryInput):Promise<C.LeaveHistoryPreviewDto>;
 importHistory(context:CommandContext,input:C.ImportLeaveHistoryInput):Promise<C.LeaveStoredRequestDto[]>;
 previewBulk(context:CommandContext,input:C.BulkLeaveRequestInput):Promise<C.LeaveWithWarnings<C.LeaveBulkPreviewDto>>;
 previewSettings(context:CommandContext,input:C.PutLeaveSettingsInput):Promise<C.LeaveWithWarnings<C.LeaveRecalculationPreviewDto>>;
 previewProfile(context:CommandContext,membershipId:string,input:C.PutLeaveProfileInput):Promise<C.LeaveWithWarnings<C.LeaveRecalculationPreviewDto>>;
 preview(context:CommandContext,input:C.PreviewLeaveRequestInput):Promise<C.LeaveWithWarnings<C.LeaveRequestPreviewDto>>;
 overview(context:CommandContext):Promise<C.LeaveWithWarnings<C.LeaveOverviewDto>>;
 availability(context:CommandContext,input:C.LeaveAvailabilityInput):Promise<C.LeaveAvailabilityDto>;
 settings(context:CommandContext,input:C.PutLeaveSettingsInput):Promise<C.LeaveSettingsDto>;
 template(context:CommandContext,input:C.ApplyLeaveTemplateInput):Promise<C.LeaveSettingsDto>;
 profile(context:CommandContext,membershipId:string,input:C.PutLeaveProfileInput):Promise<C.LeaveProfileDto>;
 create(context:CommandContext,input:C.CreateLeaveRequestInput):Promise<C.LeaveRequestDto>;
 update(context:CommandContext,requestId:string,input:C.UpdateLeaveRequestInput):Promise<C.LeaveRequestDto>;
 decide(context:CommandContext,requestId:string,input:C.DecideLeaveRequestInput):Promise<C.LeaveRequestDto>;
 bulk(context:CommandContext,input:C.BulkLeaveRequestInput):Promise<C.LeaveRequestDto[]>;
 adjustment(context:CommandContext,input:C.CreateLeaveAdjustmentInput):Promise<C.LeaveAdjustmentDto>;
}
