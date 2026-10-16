import { useTranslation } from '../../i18n';
import type { MembershipDto, SectionDto, TaskStatusDto } from '@workloom/contracts';
import { TextInput, inputClassName } from '@workloom/ui';
import { useId } from 'react';

/** Page-owned draft of the meeting template shared by every occurrence of a series. */
export interface RecurrenceTemplateDraft {
  title: string;
  statusId: string;
  /** Empty string means no section. */
  sectionId: string;
  organizerMembershipId: string;
  /** Only explicitly checked members; the organizer is not added implicitly. */
  attendeeMembershipIds: string[];
  joinUrl: string;
}

export interface RecurrenceTemplateFieldsProps {
  value: RecurrenceTemplateDraft;
  onChange: (next: RecurrenceTemplateDraft) => void;
  members: readonly MembershipDto[];
  statuses: readonly TaskStatusDto[];
  sections: readonly SectionDto[];
  disabled?: boolean | undefined;
}

const labelClass = 'text-sm font-medium';

/** Keeps a saved ID selectable when the lookup no longer contains it; the ID itself is never shown. */
function MissingOption({ selected, known, label }: { selected: string; known: readonly { id: string }[]; label: string }) {
  if (!selected || known.some((item) => item.id === selected)) return null;
  return <option value={selected}>{label}</option>;
}

export function RecurrenceTemplateFields({ value, onChange, members, statuses, sections, disabled = false }: RecurrenceTemplateFieldsProps) {
  const { t } = useTranslation();
  const id = useId();
  const set = <K extends keyof RecurrenceTemplateDraft>(key: K, next: RecurrenceTemplateDraft[K]) => onChange({ ...value, [key]: next });
  const toggleAttendee = (membershipId: string, checked: boolean) =>
    set(
      'attendeeMembershipIds',
      checked
        ? value.attendeeMembershipIds.includes(membershipId) ? [...value.attendeeMembershipIds] : [...value.attendeeMembershipIds, membershipId]
        : value.attendeeMembershipIds.filter((item) => item !== membershipId),
    );
  const knownMemberIds = new Set(members.map((m) => m.id));
  const missingAttendeeIds = value.attendeeMembershipIds.filter((membershipId) => !knownMemberIds.has(membershipId));

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4">
      <div className="min-w-0 space-y-1.5">
        <label htmlFor={`${id}-title`} className={labelClass}>{t('recurrence.meetingTitle')}</label>
        <TextInput
          id={`${id}-title`}
          value={value.title}
          maxLength={500}
          aria-describedby={`${id}-title-hint`}
          onChange={(e) => set('title', e.target.value)}
        />
        <p id={`${id}-title-hint`} className="text-xs text-muted">{t('recurrence.eachMeetingInTheSeriesUsesThisTitle')}</p>
      </div>

      <div className="min-w-0 space-y-1.5">
        <label htmlFor={`${id}-organizer`} className={labelClass}>{t('recurrence.organizer')}</label>
        <select
          id={`${id}-organizer`}
          className={inputClassName()}
          value={value.organizerMembershipId}
          onChange={(e) => set('organizerMembershipId', e.target.value)}
        >
          <option value="">{t('recurrence.chooseAnOrganizer')}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>{m.displayName}</option>
          ))}
          <MissingOption selected={value.organizerMembershipId} known={members} label={t('recurrence.savedOrganizerUnavailable')} />
        </select>
      </div>

      <fieldset className="min-w-0 space-y-2">
        <legend className={`mb-2 ${labelClass}`}>{t('recurrence.seriesParticipants')}</legend>
        {members.length === 0 && missingAttendeeIds.length === 0 ? (
          <p className="text-sm text-muted">{t('recurrence.noAvailableWorkspaceMembers')}</p>
        ) : null}
        {members.map((m) => (
          <label key={m.id} className="flex min-w-0 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value.attendeeMembershipIds.includes(m.id)}
              onChange={(e) => toggleAttendee(m.id, e.target.checked)}
            />
            <span className="min-w-0 [overflow-wrap:anywhere]">{m.displayName}</span>
          </label>
        ))}
        {missingAttendeeIds.map((membershipId, index) => (
          <label key={membershipId} className="flex min-w-0 items-center gap-2 text-sm">
            <input type="checkbox" checked onChange={(e) => toggleAttendee(membershipId, e.target.checked)} />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {missingAttendeeIds.length > 1 ? t('recurrence.savedPersonUnavailable2', { position: index + 1 }) : t('recurrence.savedPersonUnavailable3')}
            </span>
          </label>
        ))}
        <p className="text-xs text-muted">{t('recurrence.theOrganizerIsIncludedOnlyWhenTheirCheckboxIs')}</p>
      </fieldset>

      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={`${id}-status`} className={labelClass}>{t('recurrence.meetingStatus')}</label>
          <select id={`${id}-status`} className={inputClassName()} value={value.statusId} onChange={(e) => set('statusId', e.target.value)}>
            <option value="">{t('recurrence.chooseAStatus')}</option>
            {statuses.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
            <MissingOption selected={value.statusId} known={statuses} label={t('recurrence.savedStatusUnavailable')} />
          </select>
        </div>
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={`${id}-section`} className={labelClass}>{t('recurrence.meetingSection')}</label>
          <select id={`${id}-section`} className={inputClassName()} value={value.sectionId} onChange={(e) => set('sectionId', e.target.value)}>
            <option value="">{t('recurrence.noSection')}</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
            <MissingOption selected={value.sectionId} known={sections} label={t('recurrence.savedSectionUnavailable')} />
          </select>
        </div>
      </div>

      <div className="min-w-0 space-y-1.5">
        <label htmlFor={`${id}-url`} className={labelClass}>{t('recurrence.meetingLink')}</label>
        <TextInput
          id={`${id}-url`}
          type="url"
          inputMode="url"
          placeholder={t('recurrence.webAddressExample')}
          value={value.joinUrl}
          aria-describedby={`${id}-url-hint`}
          onChange={(e) => set('joinUrl', e.target.value)}
        />
        <p id={`${id}-url-hint`} className="text-xs text-muted">{t('recurrence.optionalUseAnHttpOrHttpsAddressNoInvitations')}</p>
      </div>
    </fieldset>
  );
}
