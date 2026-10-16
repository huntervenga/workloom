// This seam is independent of PostgreSQL; production still uses the real API/domain.
export function createCommandJournal({ contracts, state, persist, send, basePath, operationId }) {
  return async function command(label, method, path, proposed, inputSchema, responseSchema) {
    if (!path.startsWith(`${basePath}/`)) throw new Error('Product mutation escaped the dedicated demo workspace.');
    let record = state.commands[label];
    if (record && (record.method !== method || record.path !== path || record.inputSchema !== inputSchema || record.responseSchema !== responseSchema)) throw new Error('Command manifest drift; refusing a different operation.');
    if (!record) {
      const body = contracts[inputSchema].parse(proposed);
      record = { method, path, body, serializedBody: JSON.stringify(body), inputSchema, responseSchema, operationKey: operationId(label) };
      state.commands[label] = record;
      persist(); // complete/fsynced original input before the first send
    }
    if (!record.serializedBody || JSON.stringify(contracts[inputSchema].parse(JSON.parse(record.serializedBody))) !== JSON.stringify(record.body)) throw new Error('Stored command body is invalid or has changed.');
    if (record.response) return contracts[responseSchema].parse({ data: record.response, meta: { requestId: 'saved-demo-result' } }).data;
    const result = await send(method, path, record.body, responseSchema, record.operationKey, record.serializedBody);
    record.response = result; record.acknowledgedAt = new Date().toISOString(); persist();
    return result;
  };
}

export async function requestDemoJson({ fetcher = globalThis.fetch, app, method, path, body, responseSchema, contracts, operationKey, serializedBody }) {
  const response = await fetcher(app + path, { method, redirect: 'error',
    headers: { accept: 'application/json', origin: app, ...(body ? { 'content-type': 'application/json' } : {}), ...(operationKey ? { 'idempotency-key': operationKey } : {}) },
    ...(body ? { body: serializedBody ?? JSON.stringify(body) } : {}), signal: globalThis.AbortSignal.timeout(15_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`API returned ${response.status} (${typeof result.error?.code === 'string' ? result.error.code : 'controlled response'}). Preserve the manifest and retry the original operation.`);
  return contracts[responseSchema].parse(result).data;
}

/** A pending receipt must be replayed before any source-fresh preview can run. */
export async function resumeOrPrepare(record, prepare, submit) {
  return submit(record ? record.body : await prepare());
}
