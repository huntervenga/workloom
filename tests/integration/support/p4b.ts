import {taskScheduleContextResponseSchema,taskSchedulePreviewResponseSchema,taskScheduleApplyResponseSchema,type TaskScheduleRowInput} from '@workloom/contracts';
import {expectEnvelope} from './p1a.js';
import {P4aClient} from './p4a.js';
import type {PlanningHarness} from './p2a-fixture.js';
export class P4bClient extends P4aClient {
  schedulePath(projectId:string,action:'context'|'preview'|'apply'){return `/projects/${projectId}/schedule-${action}`;}
  async context(projectId:string,taskIds:readonly string[],baselineId?:string){return expectEnvelope(await this.get(`${this.schedulePath(projectId,'context')}?${new URLSearchParams({taskIds:taskIds.join(','),...(baselineId?{baselineId}:{})})}`),200,taskScheduleContextResponseSchema).data;}
  async schedulePreview(projectId:string,rows:TaskScheduleRowInput[]){return expectEnvelope(await this.post(this.schedulePath(projectId,'preview'),{rows},null),200,taskSchedulePreviewResponseSchema).data;}
  async apply(projectId:string,rows:TaskScheduleRowInput[],previewHash:string,key?:string){return expectEnvelope(await this.post(this.schedulePath(projectId,'apply'),{rows,previewHash},key),200,taskScheduleApplyResponseSchema).data;}
}
export function p4bClients(h:PlanningHarness){const wrap=(c:PlanningHarness['owner'])=>new P4bClient(c.api,c.workspaceId);return {owner:wrap(h.owner),replica:wrap(h.replica),member:wrap(h.member),viewer:wrap(h.viewer),outsider:wrap(h.outsider)};}
