import { projectImportSchema, taskFieldDefinitionSchema, type ProjectImportMapping, type ProjectImportPreviewDto } from '@workloom/contracts';
import { alpha } from '../../../test/fakeApi';
import { taskAt } from '../../dependencies/test/fixtures';
import { PROJECT_ID, STAMP, rootPath } from '../../planning/test/fixtures';
export { PROJECT_ID, rootPath };
export const IMPORT_ID = 'ab100000-0000-4000-8000-000000000001';
export const FIELD_ID = 'ab200000-0000-4000-8000-000000000001';
export const STATUS_ID = taskAt(1).statusId;
export function source() {
  return projectImportSchema.parse({ id: IMPORT_ID, workspaceId: alpha.id, projectId: PROJECT_ID, sourceNamespace: 'asana:pilot', fileName: 'pilot.csv', fileDigest: 'a'.repeat(64), revision: 1, status: 'staged', headers: ['Task ID', 'Name', 'Hours', 'Odd notes'], sourceRows: [{ rowNumber: 1, cells: ['000900719925474099312345', 'CSV первая', '1.5', '=SUM(1,2)'] }, { rowNumber: 2, cells: ['900719925474099312345678', 'CSV вторая', '0', 'literal note'] }], createdAt: STAMP, appliedAt: null });
}
export function durationField() {
  return taskFieldDefinitionSchema.parse({ id: FIELD_ID, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Часы источника', type: 'duration', revision: 1, definitionVersionId: 'ab300000-0000-4000-8000-000000000001', historyEnabled: true, locked: false, archivedAt: null, options: [], createdAt: STAMP, updatedAt: STAMP });
}
export function mapping(): ProjectImportMapping {
  return { externalIdColumn: 0, titleColumn: 1, defaultStatusId: STATUS_ID, dateFormat: 'iso', shareableScopeConfirmed: true, assigneeIsParticipant: false, people: [], statuses: [], sections: [], tags: [], customFields: [{ column: 2, fieldId: FIELD_ID, expectedDefinitionRevision: 1, empty: 'missing', sourceMeaning: 'current_estimate', sourceUnit: 'hours' }], preserveColumns: [3] };
}
export function preview(map: ProjectImportMapping): ProjectImportPreviewDto {
  const staged = source();
  return { importId: IMPORT_ID, projectId: PROJECT_ID, importRevision: 1, sourceDigest: staged.fileDigest, previewHash: 'b'.repeat(64), rows: staged.sourceRows.map(row => ({ rowNumber: row.rowNumber, externalId: row.cells[0] ?? null, targetTaskId: null, action: 'create', title: row.cells[1] ?? '', parentExternalId: null, customValues: map.customFields.map(field => ({ fieldId: field.fieldId, value: { type: 'duration', value: row.rowNumber === 1 ? 90 : 0 }, sourceMeaning: field.sourceMeaning, ...(field.sourceUnit ? { sourceUnit: field.sourceUnit } : {}) })) })), issues: [], summary: { sourceRows: 2, createCount: 2, skipCount: 0, conflictCount: 0, blockedCount: 0, preservedColumnCount: map.preserveColumns.length }, recoveryPeriodIds: [] };
}
