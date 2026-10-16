import {
  applyProjectImportInputSchema,
  idSchema,
  previewProjectImportInputSchema,
  projectImportAppliedResponseSchema,
  projectImportPreviewResponseSchema,
  projectImportReconciliationResponseSchema,
  projectImportResponseSchema,
  stageCsvImportInputSchema,
} from '@workloom/contracts';
import { toCommandContext, type ProjectImportApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';

export interface ImportRouteDependencies {
  readonly identity: IdentityAdapter;
  readonly imports: ProjectImportApplication;
}

const BASE = '/api/v1/workspaces/:workspaceId/projects/:projectId/imports';
const projectParams = z.object({ workspaceId: idSchema, projectId: idSchema });
const artifactParams = projectParams.extend({ importId: idSchema });
const noQuery = z.strictObject({});
// A decoded1MiB CSV can expand6x through legal JSON escaping. Domain checks decoded UTF8 bytes.
const STAGE_BODY_LIMIT = 8 * 1024 * 1024;
const MAPPING_BODY_LIMIT = 256 * 1024;

/** Transport only. Domain owns import capability, lossless CSV parsing, provenance and one atomic apply. */
export function registerImportRoutes(app: FastifyInstance, deps: ImportRouteDependencies): void {
  async function context(request: FastifyRequest, workspaceId: string, key?: string) {
    const actor = await deps.identity.resolveActor(request);
    // The shared import application derives source:'import' without changing this trusted actor/requestId.
    return toCommandContext({ actor, source: 'web', requestId: request.id }, workspaceId, key);
  }
  async function params<P extends { workspaceId: string }>(request: FastifyRequest, schema: z.ZodType<P>) {
    const result = parseInput(schema, request.params);
    parseInput(noQuery, request.query);
    return result;
  }

  app.post(BASE, { bodyLimit: STAGE_BODY_LIMIT }, async (request, reply) => {
    const p = await params(request, projectParams);
    const key = readIdempotencyKey(request);
    const input = parseInput(stageCsvImportInputSchema, request.body);
    const ctx = await context(request, p.workspaceId, key);
    return sendData(request, reply, projectImportResponseSchema, await deps.imports.stageCsv(ctx, p.projectId, input), { statusCode: 201 });
  });
  app.get(`${BASE}/:importId`, async (request, reply) => {
    const p = await params(request, artifactParams);
    const ctx = await context(request, p.workspaceId);
    return sendData(request, reply, projectImportResponseSchema, await deps.imports.getImport(ctx, p.projectId, p.importId));
  });
  app.post(`${BASE}/:importId/preview`, { bodyLimit: MAPPING_BODY_LIMIT }, async (request, reply) => {
    const p = await params(request, artifactParams);
    const input = parseInput(previewProjectImportInputSchema, request.body);
    const ctx = await context(request, p.workspaceId);
    return sendData(request, reply, projectImportPreviewResponseSchema, await deps.imports.previewImport(ctx, p.projectId, p.importId, input));
  });
  app.post(`${BASE}/:importId/apply`, { bodyLimit: MAPPING_BODY_LIMIT }, async (request, reply) => {
    const p = await params(request, artifactParams);
    const key = readIdempotencyKey(request);
    const input = parseInput(applyProjectImportInputSchema, request.body);
    const ctx = await context(request, p.workspaceId, key);
    return sendData(request, reply, projectImportAppliedResponseSchema, await deps.imports.applyImport(ctx, p.projectId, p.importId, input));
  });
  app.get(`${BASE}/:importId/reconciliation`, async (request, reply) => {
    const p = await params(request, artifactParams);
    const ctx = await context(request, p.workspaceId);
    return sendData(request, reply, projectImportReconciliationResponseSchema, await deps.imports.getReconciliation(ctx, p.projectId, p.importId));
  });
}
