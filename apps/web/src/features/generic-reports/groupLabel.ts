import { statusLabels } from './translationKeys';
import type { GenericReportConfig, TaskStatusGroup, MembershipDto, SectionDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { t } from '../../i18n';
/** Synthetic labels are derived from typed grouping and IDs, never from matching user-visible names. */
export function reportGroupLabel(config: GenericReportConfig, key: string, label: string, fields: readonly TaskFieldDefinitionDto[], members: readonly MembershipDto[], sections: readonly SectionDto[]): string {
  const group = config.groupBy;
  if (group.kind === 'none') return t('genericReports.allTasks');
  if (group.kind === 'status') return t(Object.hasOwn(statusLabels, key) ? statusLabels[key as TaskStatusGroup] : 'genericReports.unavailableGroup');
  if (group.kind === 'assignee') return key === 'unassigned' ? t('genericReports.unassigned') : members.find(member => member.id === key)?.displayName ?? t('genericReports.formerMember');
  if (group.kind === 'section') return key === 'no_section' ? t('genericReports.noSection') : sections.find(section => section.id === key)?.name ?? t('genericReports.archivedSection');
  if (key === 'uncategorized') return t('genericReports.uncategorized');
  return fields.find(field => field.id === group.fieldId)?.options.find(option => option.id === key)?.name ?? (key ? t('genericReports.unavailableCategory') : label);
}
