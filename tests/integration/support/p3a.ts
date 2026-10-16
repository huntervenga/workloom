// Frozen ten-route P3a catalog from docs/15; actual HTTP and persisted source unions.
import {
  attendanceHistoryListResponseSchema, attendancePostingResponseSchema,
  meetingAttendanceListResponseSchema, meetingCreationResponseSchema, meetingListResponseSchema,
  meetingPlanPreviewResponseSchema, meetingPlanResultResponseSchema, meetingResponseSchema,
  recordedWorkListResponseSchema,
  type ApplyMeetingPlanInput, type AttendanceDto, type AttendanceHistoryDto,
  type ConfirmAttendanceInput, type CreateMeetingInput, type MeetingListItemDto,
  type MeetingPlanPreviewInput, type RecordedWorkLogDto, type UpdateMeetingInput,
} from '@workloom/contracts';

import { expectEnvelope } from './p1a.js';
import { P2bClient } from './p2b.js';

export class P3aClient extends P2bClient {
  async createMeeting(projectId: string, input: CreateMeetingInput, key?: string) {
    return expectEnvelope(await this.post(`/projects/${projectId}/meetings`, input, key), 201, meetingCreationResponseSchema).data;
  }
  meetings(projectId: string, plannedPeriodId: string, state: 'scheduled' | 'cancelled' | 'all' = 'all'): Promise<MeetingListItemDto[]> {
    return this.all(`/projects/${projectId}/meetings`, meetingListResponseSchema, { plannedPeriodId, state });
  }
  async meeting(taskId: string) {
    return expectEnvelope(await this.get(`/tasks/${taskId}/meeting`), 200, meetingResponseSchema).data;
  }
  async updateMeeting(taskId: string, input: UpdateMeetingInput, key?: string) {
    return expectEnvelope(await this.patch(`/tasks/${taskId}/meeting`, input, key), 200, meetingResponseSchema).data;
  }
  attendance(taskId: string): Promise<AttendanceDto[]> {
    return this.all(`/tasks/${taskId}/attendance`, meetingAttendanceListResponseSchema);
  }
  async confirm(taskId: string, input: ConfirmAttendanceInput, key?: string) {
    return expectEnvelope(await this.post(`/tasks/${taskId}/attendance/confirm`, input, key), 200, attendancePostingResponseSchema).data;
  }
  recordedWork(periodId: string, extra: { taskId?: string; membershipId?: string } = {}): Promise<RecordedWorkLogDto[]> {
    return this.all('/recorded-work', recordedWorkListResponseSchema, { periodId, ...extra });
  }
  attendanceHistory(taskId: string, attendanceId: string): Promise<AttendanceHistoryDto[]> {
    return this.all(`/tasks/${taskId}/attendance/${attendanceId}/history`, attendanceHistoryListResponseSchema);
  }
  async planPreview(taskId: string, input: MeetingPlanPreviewInput) {
    return expectEnvelope(await this.post(`/tasks/${taskId}/meeting-plan-preview`, input, null), 200, meetingPlanPreviewResponseSchema).data;
  }
  async applyPlan(taskId: string, input: ApplyMeetingPlanInput, key?: string) {
    return expectEnvelope(await this.post(`/tasks/${taskId}/meeting-plan`, input, key), 200, meetingPlanResultResponseSchema).data;
  }
}
