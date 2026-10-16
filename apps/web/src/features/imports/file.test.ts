import { expect, it } from 'vitest';
import { CSV_BYTE_LIMIT, readCsvFile } from './file';
const file = (bytes: Uint8Array<ArrayBuffer>) => ({ name: 'pilot.csv', size: bytes.byteLength, arrayBuffer: async () => bytes.buffer });
it('retains BOM, CRLF and large string IDs byte-for-byte when decoding a chosen local file', async () => {
  const text = '\uFEFFTask ID,Name\r\n000900719925474099312345,Пилот\r\n';
  const bytes = new TextEncoder().encode(text);
  expect(await readCsvFile(file(bytes))).toEqual({ fileName: 'pilot.csv', csvText: text });
});
it('rejects malformed UTF-8 instead of uploading replacement characters or fetching a URL', async () => {
  await expect(readCsvFile(file(new Uint8Array([0xc3, 0x28])))).rejects.toThrow('UTF-8');
  await expect(readCsvFile(file(new TextEncoder().encode('ID,Name\n1,\0')))).rejects.toThrow('нулевой');
});
it('rejects an oversized file before reading its body', async () => {
  let reads = 0;
  await expect(readCsvFile({ name: 'large.csv', size: CSV_BYTE_LIMIT + 1, arrayBuffer: async () => { reads += 1; return new ArrayBuffer(0); } })).rejects.toThrow('1 МиБ');
  expect(reads).toBe(0);
});
