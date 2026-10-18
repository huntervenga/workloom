import type { ProjectRowDto, SectionDto, TaskProjectPlacementDto, TaskStatusDto } from '@workloom/contracts';
import { project } from '../../test/fakeApi';
import { task, STAMP } from '../planning/test/fixtures';
export { task };
export const targetId = 'e0000000-0000-4000-8000-000000000002';
export const placementId = 'e1000000-0000-4000-8000-000000000002';
export const home = project(task.workspaceId, task.projectId, 'Canonical home');
export const target = project(task.workspaceId, targetId, 'Viewed project');
export const homeStatus: TaskStatusDto = { id: task.statusId, workspaceId: task.workspaceId, projectId: task.projectId, name: 'Home todo', group: 'todo', position: 0, revision: 1 };
export const homeDone: TaskStatusDto = { ...homeStatus, id: 'f6000000-0000-4000-8000-000000000003', name: 'Home done', group: 'done', position: 1 };
export const targetStatus: TaskStatusDto = { ...homeStatus, id: 'f6000000-0000-4000-8000-000000000002', projectId: targetId, name: 'Viewed todo' };
export const homePlacement: TaskProjectPlacementDto = { id: task.id, workspaceId: task.workspaceId, taskId: task.id, projectId: task.projectId, homeProjectId: task.projectId, sectionId: task.sectionId, position: task.position, revision: task.revision, archivedAt: null, createdAt: STAMP, updatedAt: STAMP };
export const placement: TaskProjectPlacementDto = { ...homePlacement, id: placementId, projectId: targetId, revision: 7, position: 40 };
export const row: ProjectRowDto = { placement, canonicalTask: task, canonicalStatus: homeStatus, homeProject: home };

export const targetSection: SectionDto = { id: 'e2000000-0000-4000-8000-000000000002', workspaceId: task.workspaceId, projectId: targetId, name: 'Target section', position: 0, revision: 1, archivedAt: null };
