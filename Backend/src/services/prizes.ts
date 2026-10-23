/**
 * Splits a season's prize pool by points. Pure and deterministic (unit-tested in test/prizes.test.ts).
 *
 *  - Proportional: each winner gets pool x (their points / winners' points).
 *  - Cap: nobody gets more than `capCents`; what a capped player would have had goes to the others.
 *  - Minimum: shares under `minCents` (at least 1 cent) aren't paid (payout fees would eat them). Those players
 *    drop out and the rest share their part. Players on equal points are always treated the same (all paid or none).
 *  - Integer cents. Rounding leftovers go to the largest fractional remainders. Money nobody can take
 *    (everyone capped) is returned as `unallocatedCents` to roll into the next pool.
 */

export interface PrizeEntry {
  userId: string;
  points: bigint;
}

export interface Award {
  userId: string;
  points: bigint;
  /** Tied players share a rank. */
  rank: number;
  amountCents: number;
}

export interface Allocation {
  awards: Award[];
  unallocatedCents: number;
}

export function allocatePool(entries: PrizeEntry[], poolCents: number, capCents: number, minCents: number): Allocation {
  if (![poolCents, capCents, minCents].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('amounts must be non-negative integer cents');
  if (capCents < minCents) throw new Error('the cap must be at least the minimum payout');
  // Nobody is "awarded" 0 cents.
  minCents = Math.max(1, minCents);
  const sorted = entries
    .filter((e) => e.points > 0n)
    .sort((a, b) => (a.points === b.points ? (a.userId < b.userId ? -1 : 1) : a.points > b.points ? -1 : 1));
  if (sorted.length === 0 || poolCents === 0 || capCents === 0) return { awards: [], unallocatedCents: poolCents };

  // Candidate winner counts end on a tie-group boundary.
  const bounds: number[] = [];
  for (let i = 1; i <= sorted.length; i++) if (i === sorted.length || sorted[i]!.points !== sorted[i - 1]!.points) bounds.push(i);

  // Water-filling over the top k: cap the largest shares one by one (capping raises everyone else's share).
  const fill = (k: number) => {
    let rest = BigInt(poolCents);
    let sum = 0n;
    for (let i = 0; i < k; i++) sum += sorted[i]!.points;
    let capped = 0;
    const cap = BigInt(capCents);
    while (capped < k && rest * sorted[capped]!.points > cap * sum) {
      rest -= cap;
      sum -= sorted[capped]!.points;
      capped++;
    }
    return { capped, rest, sum };
  };
  // The smallest share among the top k, compared exactly: rest x p / sum >= min.
  const smallestOk = (k: number) => {
    const { capped, rest, sum } = fill(k);
    if (capped === k) return true;
    return rest * sorted[k - 1]!.points >= BigInt(minCents) * sum;
  };

  // More winners -> smaller shares, so the largest valid k is a binary search over the group boundaries.
  let lo = -1;
  let hi = bounds.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (smallestOk(bounds[mid]!)) lo = mid;
    else hi = mid - 1;
  }
  if (lo < 0) return { awards: [], unallocatedCents: poolCents };
  const k = bounds[lo]!;

  const { capped, rest, sum } = fill(k);
  const amounts: number[] = new Array(k).fill(capCents);
  const remainders: Array<{ i: number; r: bigint }> = [];
  let given = 0n;
  for (let i = capped; i < k; i++) {
    const exact = rest * sorted[i]!.points;
    amounts[i] = Number(exact / sum);
    given += exact / sum;
    remainders.push({ i, r: exact % sum });
  }
  let leftover = Number(rest - given);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (leftover === 0) break;
    if (amounts[i]! + 1 > capCents) continue;
    amounts[i]! += 1;
    leftover--;
  }

  const awards: Award[] = [];
  for (let i = 0; i < k; i++) {
    const rank = i > 0 && sorted[i]!.points === sorted[i - 1]!.points ? awards[i - 1]!.rank : i + 1;
    awards.push({ userId: sorted[i]!.userId, points: sorted[i]!.points, rank, amountCents: amounts[i]! });
  }
  const paid = amounts.reduce((a, b) => a + b, 0);
  return { awards, unallocatedCents: poolCents - paid };
}
