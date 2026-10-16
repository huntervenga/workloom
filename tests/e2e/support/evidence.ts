import { writeFile } from 'node:fs/promises';
import type { TestInfo } from '@playwright/test';
/** Keep JSON on disk even when a later scoped run replaces the HTML report. */
export async function evidenceJson(info: TestInfo, name: string, value: unknown) {
  const path = info.outputPath(name); await writeFile(path, JSON.stringify(value, null, 2)); await info.attach(name, { path, contentType: 'application/json' });
}
