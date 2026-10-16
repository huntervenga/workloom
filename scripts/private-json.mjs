// A private same-directory write-ahead file. Rename publishes only complete JSON.
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function writePrivateJson(path, value) {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path); chmodSync(path, 0o600);
    // Persist the name change too, before an API command can be sent.
    const parent = openSync(directory, 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}
