import { observeWorkspaceCommits } from '@workloom/db';
import type { FastifyInstance } from 'fastify';

export const CHANGE_SEQ_HEADER = 'x-workloom-change-seq';

/**
 * Tells the caller which change sequences its own request committed ("<workspaceId>:<seq>[,…]"), so its live refresh
 * can recognise a head that moved only because of its own writes. Replayed or failed requests commit nothing and send none.
 */
export function registerOwnCommitHeader(app: FastifyInstance): void {
  const collected = new WeakMap<object, string[]>();
  app.addHook('onRequest', (request, _reply, done) => {
    const list: string[] = [];
    collected.set(request, list);
    observeWorkspaceCommits(change => { if (list.length < 20) list.push(`${change.workspaceId}:${change.changeSeq}`); }, done);
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const list = collected.get(request);
    if (list && list.length > 0) reply.header(CHANGE_SEQ_HEADER, list.join(','));
    return payload;
  });
}
