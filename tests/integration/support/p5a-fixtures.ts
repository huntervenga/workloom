// Synthetic CSV oracle independent of the production parser. No real export/account data.
export const IMPORT_HEADERS = ['External ID', 'Name', 'Description', 'Start', 'Due', 'Assignee', 'Status', 'Section', 'Tags', 'Parent ID', 'Private', 'Current estimate', 'Current actual', 'Count', 'Checked', 'Recorded date', 'Literal text', 'Preserved notes'] as const;
export const IMPORT_IDS = ['000900719925474099312345', '900719925474099312346', '000child-003'] as const;
export type SyntheticImportRow = Record<(typeof IMPORT_HEADERS)[number], string>;
export function importRows(): SyntheticImportRow[] {
  return IMPORT_IDS.map((id, i) => ({
    'External ID': id, Name: ['Подготовить, выпуск', 'Проверить выпуск', 'Опубликовать результат'][i] ?? 'Работа',
    Description: i === 0 ? 'Первая строка\nВторая строка, с запятой и "кавычками"' : 'Синтетическая работа',
    Start: '2027-02-01', Due: '2027-02-05', Assignee: 'owner@example.invalid', Status: 'Open', Section: 'Launch', Tags: 'Local|Reviewed',
    'Parent ID': i === 1 ? IMPORT_IDS[0] : '', Private: 'false', 'Current estimate': '1.5', 'Current actual': '2', Count: i === 0 ? '0' : String(i), Checked: i === 0 ? 'false' : 'true', 'Recorded date': '2000-02-29',
    'Literal text': i === 0 ? '=HYPERLINK("https://example.invalid","literal")' : '<script>literal source text</script>',
    'Preserved notes': 'https://example.invalid/source-only — do not fetch',
  }));
}
export function importCsv(rows: readonly SyntheticImportRow[] = importRows(), headers: readonly string[] = IMPORT_HEADERS, bom = true): string {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  return (bom ? '\uFEFF' : '') + [headers.map(quote).join(','), ...rows.map(row => headers.map(header => quote(row[header as keyof SyntheticImportRow] ?? '')).join(','))].join('\r\n') + '\r\n';
}
