export const CSV_BYTE_LIMIT = 1048576;
export interface CsvFileSource { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> }
export interface CsvUpload { fileName: string; csvText: string }
/** Decode locally; the server remains the only CSV parser and never receives a replacement-decoded file. */
export async function readCsvFile(file: CsvFileSource): Promise<CsvUpload> {
  if (file.size > CSV_BYTE_LIMIT) throw new Error('Файл больше 1 МиБ. Ограниченный импорт не обрезает файл: выберите меньший CSV.');
  if (file.size === 0) throw new Error('Файл пуст. Выберите CSV с заголовками и задачами.');
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > CSV_BYTE_LIMIT) throw new Error('Файл больше 1 МиБ.');
  let csvText: string;
  try { csvText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('Не удалось прочитать UTF-8. Сохраните файл в UTF-8 без замены неизвестных символов.'); }
  if (csvText.includes('\0')) throw new Error('CSV содержит недопустимый нулевой символ.');
  if (!file.name || file.name.length > 255 || file.name.includes('\0') || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(file.name)) !== file.name) throw new Error('Укажите корректное имя файла длиной до 255 символов.');
  return { fileName: file.name, csvText };
}
