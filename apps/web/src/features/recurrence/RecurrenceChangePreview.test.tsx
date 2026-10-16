import { recurrenceExceptionPreviewSchema } from '@workloom/contracts';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { alphaMembers } from '../../test/fakeApi';
import { RecurrenceExceptionPreview } from './RecurrenceChangePreview';
import { HASH_A, instance, plannedCalendar, SERIES_ID } from './test/fixtures';

/** Reset/restore can apply a new version's roster without overwriting ordinary task data. */
describe('exception planned-calendar review', () => {
  it.each(['reset', 'restore'] as const)('shows the actual before/after calendar and named roster before %s is applied', kind => {
    const [anna, vera, gleb] = alphaMembers;
    if (!anna || !vera || !gleb) throw new Error('Expected three fixture members');
    const target = instance('2026-10-19', { ordinal: 1 });
    const preview = recurrenceExceptionPreviewSchema.parse({
      seriesId: SERIES_ID,
      instanceId: target.id,
      occurrenceKey: target.occurrenceKey,
      kind,
      previewHash: HASH_A,
      before: target.resolution,
      after: target.resolution,
      calendarStateAfter: 'scheduled',
      protectedReasons: [],
      // Deliberately distinct from resolution.duration: the actual meeting/roster is authoritative here.
      beforePlannedCalendar: plannedCalendar({ timezone: 'Europe/Berlin', plannedDurationMinutes: 45, organizerMembershipId: anna.id, attendeeMembershipIds: [anna.id, vera.id] }),
      afterPlannedCalendar: plannedCalendar({ timezone: 'Asia/Nicosia', plannedDurationMinutes: 90, organizerMembershipId: gleb.id, attendeeMembershipIds: [vera.id, gleb.id] }),
    });
    render(<RecurrenceExceptionPreview preview={preview} members={alphaMembers} />);
    const review = screen.getByRole('region', { name: "Planned schedule and people" });
    const before = within(review).getByRole('region', { name: "Current" });
    const after = within(review).getByRole('region', { name: "After change" });
    expect(before).toHaveTextContent('Europe/Berlin');
    expect(before).toHaveTextContent("45 min");
    expect(after).toHaveTextContent('Asia/Nicosia');
    expect(after).toHaveTextContent("90 min");
    const beforeOrganizer = within(before).getByText("Organizer").nextElementSibling;
    const afterOrganizer = within(after).getByText("Organizer").nextElementSibling;
    expect(beforeOrganizer).toHaveTextContent(anna.displayName);
    expect(afterOrganizer).toHaveTextContent(gleb.displayName);
    const beforeRoster = within(before).getByRole('list');
    const afterRoster = within(after).getByRole('list');
    expect(beforeRoster).toHaveTextContent(anna.displayName);
    expect(beforeRoster).toHaveTextContent(vera.displayName);
    expect(afterRoster).not.toHaveTextContent(anna.displayName);
    expect(afterRoster).toHaveTextContent(vera.displayName);
    expect(afterRoster).toHaveTextContent(gleb.displayName);
    expect(within(beforeRoster).getByText("Excluded from new roster").closest('li')).toHaveTextContent(anna.displayName);
    expect(within(afterRoster).getByText("Will add").closest('li')).toHaveTextContent(gleb.displayName);
    expect(review).toHaveTextContent("Title, status, materials, and recorded hours are preserved.");
    for (const member of alphaMembers) expect(document.body).not.toHaveTextContent(member.id);
  });
});
