import type { MembershipDto, TaskFieldData, TaskFieldDefinitionDto, TaskFieldOptionDto, TaskFieldType } from '@workloom/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { FieldInput } from './FieldInput';
import { FieldValueDisplay } from './FieldValueDisplay';
import { draftFromFieldValue, parseFieldDraft, type FieldDraft } from './valueDraft';

const WORKSPACE = '5f0c2c1e-7a1b-4c3d-8e9f-000000000002';
const ALPHA = '0b6f4f8e-1d6a-4b8a-9f1e-1a2b3c4d5e01';
const BETA = '0b6f4f8e-1d6a-4b8a-9f1e-1a2b3c4d5e02';
const GAMMA = '0b6f4f8e-1d6a-4b8a-9f1e-1a2b3c4d5e03';
const MISSING = '0b6f4f8e-1d6a-4b8a-9f1e-1a2b3c4d5e09';
const ANNA = '7c1d2e3f-4a5b-4c6d-8e7f-000000000001';
const GONE = '7c1d2e3f-4a5b-4c6d-8e7f-000000000099';

const anna: MembershipDto = { id: ANNA, workspaceId: WORKSPACE, userId: '7c1d2e3f-4a5b-4c6d-8e7f-0000000000aa', displayName: 'Анна Ковалёва', role: 'member' };

function option(id: string, name: string, position: number, archived = false): TaskFieldOptionDto {
  return { id, name, color: '#3366ff', position, revision: 1, archivedAt: archived ? '2026-10-02T00:00:00.000Z' : null };
}

function makeField(type: TaskFieldType, name = "Field", options: TaskFieldOptionDto[] = []): TaskFieldDefinitionDto {
  return {
    id: '5f0c2c1e-7a1b-4c3d-8e9f-000000000001',
    workspaceId: WORKSPACE,
    projectId: '5f0c2c1e-7a1b-4c3d-8e9f-000000000003',
    name,
    type,
    revision: 1,
    definitionVersionId: '5f0c2c1e-7a1b-4c3d-8e9f-000000000004',
    historyEnabled: true,
    locked: false,
    archivedAt: null,
    options,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

const tagsField = makeField('multi_select', 'Метки', [
  option(ALPHA, 'Альфа', 0),
  option(BETA, 'Бета', 1, true),
  option(GAMMA, 'Гамма', 2, true),
]);

function Harness(props: {
  field: TaskFieldDefinitionDto;
  initial: FieldDraft;
  originalValue?: TaskFieldData | null;
  error?: string | null;
  onDraft: (draft: FieldDraft) => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  return (
    <FieldInput
      field={props.field}
      draft={draft}
      members={[anna]}
      originalValue={props.originalValue}
      error={props.error}
      onChange={(next) => {
        setDraft(next);
        props.onDraft(next);
      }}
    />
  );
}

function lastParsed(field: TaskFieldDefinitionDto, onDraft: Mock<(draft: FieldDraft) => void>) {
  const draft = onDraft.mock.lastCall?.[0];
  if (!draft) throw new Error('No draft emitted');
  return parseFieldDraft(field, draft);
}

describe('FieldInput', () => {
  it('keeps saved archived and unknown options removable but never offers new archived ones', async () => {
    const user = userEvent.setup();
    const onDraft = vi.fn<(draft: FieldDraft) => void>();
    const saved: TaskFieldData = { type: 'multi_select', value: [ALPHA, BETA, MISSING] };
    render(<Harness field={tagsField} initial={draftFromFieldValue(tagsField, saved)} originalValue={saved} onDraft={onDraft} />);

    expect(screen.getByRole('group', { name: 'Метки' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Гамма/ })).not.toBeInTheDocument();
    const archived = screen.getByRole('checkbox', { name: "Бета (archived)" });
    const unknown = screen.getByRole('checkbox', { name: "Option unavailable" });
    expect(archived).toBeChecked();
    expect(unknown).toBeChecked();

    await user.click(archived);
    expect(lastParsed(tagsField, onDraft)).toEqual({ ok: true, value: { type: 'multi_select', value: [ALPHA, MISSING] } });
    // A saved reference may be put back.
    expect(archived).toBeEnabled();
    await user.click(archived);
    await user.click(unknown);
    expect(lastParsed(tagsField, onDraft)).toEqual({ ok: true, value: { type: 'multi_select', value: [ALPHA, BETA] } });

    await user.click(screen.getByRole('button', { name: "Clear: Метки" }));
    expect(lastParsed(tagsField, onDraft)).toEqual({ ok: true, value: { type: 'multi_select', value: null } });
  });

  it('lets an archived option outside the saved value be removed but not added back', async () => {
    const user = userEvent.setup();
    const onDraft = vi.fn<(draft: FieldDraft) => void>();
    render(<Harness field={tagsField} initial={{ type: 'multi_select', value: [BETA] }} onDraft={onDraft} />);

    const archived = screen.getByRole('checkbox', { name: "Бета (archived)" });
    await user.click(archived);
    expect(lastParsed(tagsField, onDraft)).toEqual({ ok: true, value: { type: 'multi_select', value: [] } });
    expect(screen.queryByRole('checkbox', { name: "Бета (archived)" })).not.toBeInTheDocument();
  });

  it('keeps a person who left the workspace until explicitly unchecked', async () => {
    const user = userEvent.setup();
    const onDraft = vi.fn<(draft: FieldDraft) => void>();
    const field = makeField('person', 'Исполнители');
    const saved: TaskFieldData = { type: 'person', value: [ANNA, GONE] };
    render(<Harness field={field} initial={draftFromFieldValue(field, saved)} originalValue={saved} onDraft={onDraft} />);

    const gone = screen.getByRole('checkbox', { name: "Member unavailable" });
    expect(gone).toBeChecked();
    await user.click(gone);
    expect(lastParsed(field, onDraft)).toEqual({ ok: true, value: { type: 'person', value: [ANNA] } });
  });

  it('edits a duration in hours, links the error and clears to an explicit null', async () => {
    const user = userEvent.setup();
    const onDraft = vi.fn<(draft: FieldDraft) => void>();
    const field = makeField('duration', 'Время на ревью');
    render(<Harness field={field} initial={draftFromFieldValue(field, null)} error="Проверьте значение." onDraft={onDraft} />);

    const input = screen.getByRole('textbox', { name: "Время на ревью, hours" });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/Проверьте значение\./);
    await user.type(input, '1,5');
    expect(lastParsed(field, onDraft)).toEqual({ ok: true, value: { type: 'duration', value: 90 } });

    await user.click(screen.getByRole('button', { name: "Clear: Время на ревью, hours" }));
    expect(input).toHaveValue('');
    expect(lastParsed(field, onDraft)).toEqual({ ok: true, value: { type: 'duration', value: null } });
  });
});

describe('FieldValueDisplay', () => {
  function show(field: TaskFieldDefinitionDto, value: TaskFieldData | null, compact = false) {
    return render(<FieldValueDisplay field={field} value={value} members={[anna]} compact={compact} />);
  }

  it('tells a cleared value apart from false, 0 and an empty choice', () => {
    show(makeField('boolean'), { type: 'boolean', value: false });
    expect(screen.getByText("No")).toBeInTheDocument();
    show(makeField('number'), { type: 'number', value: 0 });
    expect(screen.getByText('0')).toBeInTheDocument();
    show(tagsField, { type: 'multi_select', value: [] });
    expect(screen.getByText("Nothing selected")).toBeInTheDocument();
    show(makeField('boolean'), null, true);
    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(screen.getByText('—')).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows a calendar date without a time zone shift and labels retained references', () => {
    show(makeField('date'), { type: 'date', value: '2026-01-01' });
    expect(screen.getByText('01/01/2026')).toHaveAttribute('dateTime', '2026-01-01');
    show(tagsField, { type: 'multi_select', value: [BETA, MISSING] });
    expect(screen.getByText("Бета (archived)")).toBeInTheDocument();
    expect(screen.getByText("Option unavailable")).toBeInTheDocument();
  });

  it('links only safe http(s) addresses, even for hostile stored data', () => {
    const field = makeField('url');
    const hostile = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' https://example.test', 'data:text/html,<b>x</b>', 'https://u:p@example.test'];
    for (const value of hostile) {
      const { unmount } = show(field, { type: 'url', value }, true);
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.getByText(value.trim())).toBeInTheDocument();
      unmount();
    }

    show(field, { type: 'url', value: 'https://example.test/a?b=1' });
    const link = screen.getByRole('link', { name: 'https://example.test/a?b=1' });
    expect(link).toHaveAttribute('href', 'https://example.test/a?b=1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
