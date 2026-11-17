export const RANK_STEP = 1024;

// Below this gap, float midpoints stop being distinguishable, so we respace.
const MIN_GAP = 1e-6;

export function appendRank(ranks: readonly number[]): number {
  return ranks.length === 0 ? RANK_STEP : Math.max(...ranks) + RANK_STEP;
}

export function placeCard(
  ranks: readonly number[],
  index: number,
): { rank: number; rebalanced: number[] | null } {
  const first = ranks[0];
  if (first === undefined) return { rank: RANK_STEP, rebalanced: null };
  if (index <= 0) return { rank: first - RANK_STEP, rebalanced: null };
  if (index >= ranks.length) return { rank: appendRank(ranks), rebalanced: null };

  const lower = ranks[index - 1] as number;
  const upper = ranks[index] as number;
  if (upper - lower >= MIN_GAP) {
    return { rank: (lower + upper) / 2, rebalanced: null };
  }
  // Leave a free slot at `index` for the moved card.
  const rebalanced = ranks.map((_, i) => (i < index ? i + 1 : i + 2) * RANK_STEP);
  return { rank: (index + 1) * RANK_STEP, rebalanced };
}
