import { describe, expect, it } from 'vitest';
import { classifyExportText, orderExportFiles } from './classifyExport';

const blob = (text: string) => { const bytes = new TextEncoder().encode(text); const value = new Blob([bytes]); Object.defineProperty(value, 'arrayBuffer', { value: async () => bytes.buffer.slice(0) }); return value; };
const json = blob('\ufeff{\n  "data" : [ ]\n}'), csv = blob('\ufeffTask ID,Created At,Name\n1,2,x');

describe('telling the two Asana exports apart', () => {
  it('recognizes JSON and CSV by their first characters, ignoring a byte-order mark', () => {
    expect(classifyExportText('﻿  {"data":[]}')).toBe('json');
    expect(classifyExportText('Task ID,Created At')).toBe('csv');
    expect(classifyExportText('﻿"Task ID","Created At"')).toBe('csv');
    expect(classifyExportText('Name,Owner')).toBe('unknown');
  });
  it('puts swapped files right, refuses two of a kind and leaves unrecognized content to the server', async () => {
    expect(await orderExportFiles(json, csv)).toEqual({ json, csv });
    expect(await orderExportFiles(csv, json)).toEqual({ json, csv });
    expect(await orderExportFiles(json, json)).toBeNull();
    expect(await orderExportFiles(csv, csv)).toBeNull();
    const other = blob('Name,Owner');
    expect(await orderExportFiles(json, other)).toEqual({ json, csv: other });
  });
});
