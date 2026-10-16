import { useTranslation } from '../../i18n';
import type { ProjectImportDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useState } from 'react';
export function SourceTable({ source }: { source: ProjectImportDto }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(10);
  return <details className="space-y-3 rounded-xl border border-line p-4"><summary className="cursor-pointer text-sm font-medium">{t('imports.sourceDataSummary', { rows: t('imports.rowCount', { count: source.sourceRows.length }), columns: t('imports.columnCount', { count: source.headers.length }) })}</summary><p className="mt-3 text-xs text-muted">{t('imports.columnPositionsArePreservedIncludingDuplicateHeadersRowMeans')}</p><div className="relative mt-3 max-h-96 max-w-full overflow-auto rounded-lg border border-line"><table className="min-w-full text-xs"><thead><tr><th className="border-b border-line bg-canvas p-2 text-left">{t('imports.row3')}</th>{source.headers.map((name, index) => <th key={index} className="min-w-40 border-b border-line bg-canvas p-2 text-left font-medium">{index + 1} · {name || t('imports.untitled2')}</th>)}</tr></thead><tbody>{source.sourceRows.slice(0, visible).map(row => <tr key={row.rowNumber}><th className="border-b border-line p-2 text-left font-normal">{row.rowNumber}</th>{source.headers.map((_, column) => <td key={column} className="max-w-72 border-b border-line p-2 align-top"><pre className="max-w-72 whitespace-pre-wrap break-words font-sans [overflow-wrap:anywhere]">{row.cells[column] ?? ''}</pre></td>)}</tr>)}</tbody></table></div>{source.sourceRows.length > visible ? <Button size="sm" onClick={() => setVisible(count => count + 10)}>{t('imports.showMoreSourceRows')}</Button> : null}</details>;
}
