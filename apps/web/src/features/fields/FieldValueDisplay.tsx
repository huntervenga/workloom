import type { MembershipDto, TaskFieldData, TaskFieldDefinitionDto } from '@workloom/contracts';
import { cn } from '@workloom/ui';
import { formatEstimate } from '../task-table/estimate';
import {
  NOTHING_SELECTED,
  NOT_SET,
  formatFieldNumber,
  isMinutes,
  isSafeLink,
  referenceLabels,
  type ReferenceLabel,
} from './valueDraft';

export interface FieldValueDisplayProps {
  field: TaskFieldDefinitionDto;
  value: TaskFieldData | null | undefined;
  members: readonly MembershipDto[];
  /** Single line for table cells: long values are truncated with the full text in a tooltip. */
  compact?: boolean | undefined;
}

const UNREADABLE = 'Значение недоступно';
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SWATCH_COLOR = /^#[0-9a-f]{6}$/i;

function Muted({ text, compact }: { text: string; compact: boolean }) {
  return <span className={cn('text-muted', compact && 'block truncate')}>{text}</span>;
}

function Plain({ text, compact, className }: { text: string; compact: boolean; className?: string }) {
  return (
    <span
      className={cn(compact ? 'block truncate' : 'whitespace-pre-wrap [overflow-wrap:anywhere]', className)}
      title={compact ? text : undefined}
    >
      {text}
    </span>
  );
}

function References({ labels, compact }: { labels: readonly ReferenceLabel[]; compact: boolean }) {
  return (
    <span
      className={cn(compact ? 'block truncate' : 'flex flex-wrap gap-x-2 gap-y-1')}
      title={compact ? labels.map((item) => item.label).join(', ') : undefined}
    >
      {labels.map((item, index) => (
        <span key={item.id} className={cn('min-w-0 [overflow-wrap:anywhere]', item.state !== 'active' && 'text-muted')}>
          {item.color !== null && SWATCH_COLOR.test(item.color) ? (
            <span
              aria-hidden="true"
              className="mr-1 inline-block size-2 rounded-full align-middle"
              style={{ backgroundColor: item.color }}
            />
          ) : null}
          {item.label}
          {index < labels.length - 1 ? (compact ? ', ' : <span className="sr-only">, </span>) : null}
        </span>
      ))}
    </span>
  );
}

/** Read-only value of a custom field. Handles cleared, unknown and hostile values without guessing. */
export function FieldValueDisplay({ field, value, members, compact = false }: FieldValueDisplayProps) {
  if (value === null || value === undefined || value.value === null) {
    return compact ? (
      <span title={NOT_SET} className="text-muted">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{NOT_SET}</span>
      </span>
    ) : (
      <Muted text={NOT_SET} compact={false} />
    );
  }
  if (value.type !== field.type) return <Muted text={UNREADABLE} compact={compact} />;

  switch (value.type) {
    case 'text':
      return value.value === '' ? <Muted text="Пустой текст" compact={compact} /> : <Plain text={value.value} compact={compact} />;
    case 'number':
      return Number.isFinite(value.value) ? (
        <Plain text={formatFieldNumber(value.value)} compact={compact} className="tabular-nums" />
      ) : (
        <Muted text={UNREADABLE} compact={compact} />
      );
    case 'duration':
      return isMinutes(value.value) ? (
        <Plain text={formatEstimate(value.value)} compact={compact} className="tabular-nums" />
      ) : (
        <Muted text={UNREADABLE} compact={compact} />
      );
    case 'date': {
      // A calendar date has no time zone: show its own digits, never through `Date`.
      const match = CALENDAR_DATE.exec(value.value);
      if (!match) return <Muted text={UNREADABLE} compact={compact} />;
      const [, year, month, day] = match;
      return (
        <time dateTime={value.value} className={cn('tabular-nums', compact && 'block truncate')}>
          {`${day}.${month}.${year}`}
        </time>
      );
    }
    case 'boolean':
      return <Plain text={value.value ? 'Да' : 'Нет'} compact={compact} />;
    case 'url':
      return isSafeLink(value.value) ? (
        <a
          href={value.value}
          target="_blank"
          rel="noopener noreferrer"
          title={value.value}
          className={cn(
            'text-accent underline-offset-2 hover:underline',
            compact ? 'block truncate' : '[overflow-wrap:anywhere]',
          )}
        >
          {value.value}
        </a>
      ) : (
        // Not a safe link: shown as inert text only.
        <Plain text={value.value} compact={compact} className="text-muted" />
      );
    case 'single_select':
      return <References labels={referenceLabels(field, [value.value], members)} compact={compact} />;
    case 'multi_select':
    case 'person':
      return value.value.length === 0 ? (
        <Muted text={NOTHING_SELECTED} compact={compact} />
      ) : (
        <References labels={referenceLabels(field, value.value, members)} compact={compact} />
      );
  }
}
