// Independent test oracle for the first related package freeze. It never reads the endpoint's origin or
// the stored observation, so tests can cross-check those only after picking the expected baseline here.
import type { PlanBaselineDto } from '@workloom/contracts';

export interface OracleBaseline {
  readonly id: string;
  readonly scope: PlanBaselineDto['scope'];
  readonly membershipId: string | null;
  readonly changeSeq: string;
  readonly snapshot: {
    readonly packages: readonly { readonly id: string }[];
    readonly commitments: readonly { readonly workPackageId: string; readonly membershipId: string; readonly state: string }[];
  };
}

const codeUnitOrder = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * A project freeze saves each member's personal freeze first, in default code-unit order of membership IDs,
 * inside one command, so those baselines share changeSeq and frozenAt. The first related freeze is therefore
 * a personal baseline whose snapshot holds that member's active commitment for the package, ordered by the
 * command's changeSeq and then by the sorted membership ID. Project baselines and baseline IDs never decide it.
 */
export function expectedOriginBaseline<T extends OracleBaseline>(baselines: readonly T[], packageId: string): T {
  const id = packageId.toLowerCase();
  const candidates = baselines.filter((item) => item.scope === 'self' && item.membershipId !== null
    && item.snapshot.packages.some((pkg) => pkg.id.toLowerCase() === id)
    && item.snapshot.commitments.some((c) => c.state === 'active' && c.workPackageId.toLowerCase() === id && c.membershipId.toLowerCase() === item.membershipId?.toLowerCase()));
  const ordered = [...candidates].sort((a, b) => {
    const left = BigInt(a.changeSeq), right = BigInt(b.changeSeq);
    if (left !== right) return left < right ? -1 : 1;
    return codeUnitOrder((a.membershipId ?? '').toLowerCase(), (b.membershipId ?? '').toLowerCase());
  });
  const first = ordered[0];
  if (!first) throw new Error('No personal baseline with an active commitment for this package was stored.');
  return first;
}
