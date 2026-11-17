import { describe, expect, test } from 'vitest';
import { placeCard, RANK_STEP } from './rank';

describe('card rank placement', () => {
  test('places between neighbours', () => {
    expect(placeCard([1024, 2048], 1)).toEqual({ rank: 1536, rebalanced: null });
  });

  test('places above the top and below the bottom', () => {
    expect(placeCard([1024, 2048], 0).rank).toBeLessThan(1024);
    expect(placeCard([1024, 2048], 2).rank).toBeGreaterThan(2048);
    expect(placeCard([], 0)).toEqual({ rank: RANK_STEP, rebalanced: null });
  });

  test('repeated inserts at the same slot eventually rebalance and keep order', () => {
    let ranks = [1024, 2048];
    let sawRebalance = false;
    for (let i = 0; i < 80; i++) {
      const { rank, rebalanced } = placeCard(ranks, 1);
      if (rebalanced) {
        sawRebalance = true;
        ranks = rebalanced;
      }
      ranks = [...ranks.slice(0, 1), rank, ...ranks.slice(1)];
    }
    expect(sawRebalance).toBe(true);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});
