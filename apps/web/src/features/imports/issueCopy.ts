import type { ProjectImportIssueDto } from '@workloom/contracts';
import { t, type TranslationKey } from '../../i18n';

/** Fixed UI copy by validated public code; never render untrusted server message text. */
const issueKeys = {
  missing_external_id: 'imports.issues.missing_external_id',
  duplicate_external_id: 'imports.issues.duplicate_external_id',
  missing_title: 'imports.issues.missing_title',
  unmapped_person: 'imports.issues.unmapped_person',
  unmapped_status: 'imports.issues.unmapped_status',
  unmapped_section: 'imports.issues.unmapped_section',
  unmapped_tag: 'imports.issues.unmapped_tag',
  unmapped_column: 'imports.issues.unmapped_column',
  invalid_date: 'imports.issues.invalid_date',
  invalid_value: 'imports.issues.invalid_value',
  invalid_field: 'imports.issues.invalid_field',
  parent_missing: 'imports.issues.parent_missing',
  parent_cycle: 'imports.issues.parent_cycle',
  target_changed: 'imports.issues.target_changed',
  source_changed: 'imports.issues.source_changed',
  private_source: 'imports.issues.private_source',
  scope_unconfirmed: 'imports.issues.scope_unconfirmed',
  unsupported_relationship: 'imports.issues.unsupported_relationship',
 } satisfies Record<ProjectImportIssueDto['code'], TranslationKey>;

export function importIssueCopy(issue: Pick<ProjectImportIssueDto, 'code'>): string {
  return t(Object.hasOwn(issueKeys, issue.code) ? issueKeys[issue.code] : 'imports.issues.unknown');
}
