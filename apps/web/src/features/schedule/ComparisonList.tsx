import type { ScheduleDependencyComparisonDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useState } from 'react';
import { Link } from 'react-router';
export function ComparisonList({ comparisons, names, workspaceId }: { comparisons: readonly ScheduleDependencyComparisonDto[]; names: ReadonlyMap<string, string>; workspaceId: string }) {
  const [visible, setVisible] = useState(10);
  if (!comparisons.length) return <p className="text-xs text-muted">Связей для сравнения дат нет.</p>;
  return <section aria-label="Проверка дат зависимостей" className="space-y-3"><h3 className="text-sm font-semibold">Текущие зависимости</h3><p className="text-xs text-muted">Предупреждения не сдвигают другие задачи и не заменяют проверку статусов.</p><ul className="space-y-2">{comparisons.slice(0, visible).map(item => <li key={item.dependencyId} className="space-y-1 rounded-lg border border-line p-3 text-xs">
    <p className="[overflow-wrap:anywhere]"><Link className="text-accent-ink underline" to={`/w/${workspaceId}/projects/${item.predecessorContext.project.id}?task=${item.predecessorTaskId}`}>{names.get(item.predecessorTaskId) ?? `Предшественник · ${item.predecessorContext.project.name}`}</Link> → <Link className="text-accent-ink underline" to={`/w/${workspaceId}/projects/${item.successorContext.project.id}?task=${item.successorTaskId}`}>{names.get(item.successorTaskId) ?? `Следующая задача · ${item.successorContext.project.name}`}</Link></p>
    <p className={item.state === 'conflict' ? 'font-medium text-amber-900' : 'text-muted'}>{item.state === 'conflict' ? 'Начало следующей задачи пересекается со сроком предшественника' : item.state === 'compatible' ? 'Даты согласованы' : item.reason === 'meeting_calendar' ? 'Встреча: расписание проверяется в календаре' : 'Недостаточно дат для сравнения'}</p>
  </li>)}</ul>{comparisons.length > visible ? <Button size="sm" onClick={() => setVisible(count => count + 10)}>Ещё сравнения дат</Button> : null}</section>;
}
