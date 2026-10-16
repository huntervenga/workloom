import { t, type TranslationKey } from '../../i18n';
/** Only this error class carries vetted, localized file-validation copy. */
export class CsvFileReadError extends Error {
  constructor(readonly messageKey: TranslationKey) { super(t(messageKey)); }
}
export const CSV_BYTE_LIMIT = 1048576;
export interface CsvFileSource { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> }
export interface CsvUpload { fileName: string; csvText: string }
/** Decode locally; the server remains the only CSV parser and never receives a replacement-decoded file. */
export async function readCsvFile(file: CsvFileSource): Promise<CsvUpload> {
  if (file.size > CSV_BYTE_LIMIT) throw new CsvFileReadError('imports.fileExceeds1MibImportsDoNotTruncateFiles');
  if (file.size === 0) throw new CsvFileReadError('imports.fileIsEmptyChooseACsvWithHeadersAnd');
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > CSV_BYTE_LIMIT) throw new CsvFileReadError('imports.fileExceeds1Mib');
  let csvText: string;
  try { csvText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new CsvFileReadError('imports.couldNotReadUtf8SaveTheFileAs'); }
  if (csvText.includes('\0')) throw new CsvFileReadError('imports.csvContainsAnInvalidNullCharacter');
  if (!file.name || file.name.length > 255 || file.name.includes('\0') || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(file.name)) !== file.name) throw new CsvFileReadError('imports.useAValidFileNameOfUpTo255');
  return { fileName: file.name, csvText };
}
