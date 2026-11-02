import { reportCommittedWorkspaceChange } from '@workloom/db';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { CHANGE_SEQ_HEADER, registerOwnCommitHeader } from './own-commit-header.js';

describe('own commit header', () => {
  it('reports the sequences a request committed, per request, and nothing for reads', async () => {
    const app = Fastify();
    registerOwnCommitHeader(app);
    app.post('/write', async () => {
      await new Promise(resolve => setTimeout(resolve, 3));
      reportCommittedWorkspaceChange({ workspaceId: 'w1', changeSeq: '7' });
      reportCommittedWorkspaceChange({ workspaceId: 'w1', changeSeq: '8' });
      return { ok: true };
    });
    app.post('/other', async () => { reportCommittedWorkspaceChange({ workspaceId: 'w2', changeSeq: '99' }); return { ok: true }; });
    app.get('/read', async () => ({ ok: true }));
    const [write, other, read] = await Promise.all([
      app.inject({ method: 'POST', url: '/write' }), app.inject({ method: 'POST', url: '/other' }), app.inject({ method: 'GET', url: '/read' }),
    ]);
    expect(write.headers[CHANGE_SEQ_HEADER]).toBe('w1:7,w1:8');
    expect(other.headers[CHANGE_SEQ_HEADER]).toBe('w2:99');
    expect(read.headers[CHANGE_SEQ_HEADER]).toBeUndefined();
    await app.close();
  });
});
