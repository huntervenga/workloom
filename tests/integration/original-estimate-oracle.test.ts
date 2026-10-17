import { describe, expect, it } from 'vitest';

import { expectedOriginBaseline, type OracleBaseline } from './support/original-estimate-oracle.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

// Pure regression for the PG original-estimate test oracle. Like every integration file, collection
// requires an explicit TEST_DATABASE_URL; these cases use synthetic baselines only and open no connection.
requireTestDatabaseUrl();

const id = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pkg = id('a', 1), otherPkg = id('a', 2);
const owner = id('c', 1), member = id('d', 1);
function personal(baselineId: string, membershipId: string, changeSeq: string, state = 'active', workPackageId = pkg): OracleBaseline {
  return { id: baselineId, scope: 'self', membershipId, changeSeq, snapshot: { packages: [{ id: workPackageId }], commitments: [{ workPackageId, membershipId, state }] } };
}
function projectBaseline(baselineId: string, changeSeq: string): OracleBaseline {
  return { id: baselineId, scope: 'project', membershipId: null, changeSeq, snapshot: { packages: [{ id: pkg }], commitments: [{ workPackageId: pkg, membershipId: owner, state: 'active' }] } };
}
/** The rejected oracle: related baselines by changeSeq, then baseline ID. */
function byChangeSeqThenId(baselines: readonly OracleBaseline[]) {
  return [...baselines].filter((b) => b.snapshot.packages.some((p) => p.id === pkg))
    .sort((a, b) => (BigInt(a.changeSeq) === BigInt(b.changeSeq) ? (a.id < b.id ? -1 : 1) : BigInt(a.changeSeq) < BigInt(b.changeSeq) ? -1 : 1))[0];
}

describe('original-estimate PG oracle', () => {
  it('never lets a same-command project baseline with a smaller UUID win', () => {
    const baselines = [personal(id('f', 9), owner, '41'), projectBaseline(id('0', 1), '41')];
    expect(byChangeSeqThenId(baselines)?.scope).toBe('project');
    expect(expectedOriginBaseline(baselines, pkg).id).toBe(id('f', 9));
  });

  it('orders tied personal freezes by the sorted membership loop, not by baseline ID', () => {
    const first = personal(id('f', 1), owner, '41'), second = personal(id('0', 2), member, '41');
    expect(byChangeSeqThenId([first, second])?.id).toBe(second.id);
    expect(expectedOriginBaseline([second, first], pkg.toUpperCase()).id).toBe(first.id);
  });

  it('lets an earlier non-owner command win even when the owner sorts first', () => {
    expect(owner < member).toBe(true);
    const earlier = personal(id('f', 3), member, '9'), later = personal(id('0', 4), owner, '10');
    expect(expectedOriginBaseline([later, projectBaseline(id('0', 5), '10'), earlier], pkg).id).toBe(earlier.id);
    expect(expectedOriginBaseline([personal(id('f', 6), member, '9007199254740993'), personal(id('0', 7), owner, '9007199254740994')], pkg).membershipId).toBe(member);
  });

  it('excludes personal baselines without the member own active package commitment', () => {
    const removed = personal(id('0', 8), owner, '1', 'removed');
    const elsewhere = personal(id('0', 9), owner, '1', 'active', otherPkg);
    const foreignCommitment: OracleBaseline = { ...personal(id('0', 10), owner, '1'), snapshot: { packages: [{ id: pkg }], commitments: [{ workPackageId: pkg, membershipId: member, state: 'active' }] } };
    const real = personal(id('f', 11), member, '2');
    expect(expectedOriginBaseline([removed, elsewhere, foreignCommitment, projectBaseline(id('0', 12), '1'), real], pkg).id).toBe(real.id);
    expect(() => expectedOriginBaseline([removed, elsewhere, projectBaseline(id('0', 13), '1')], pkg)).toThrow('No personal baseline');
  });
});
