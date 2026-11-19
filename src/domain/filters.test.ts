import { describe, expect, test } from 'vitest';
import {
  activeFilterCount,
  type BoardFilters,
  cardVisible,
  DEFAULT_FILTERS,
  showNewAccounts,
  showOnlyList,
  toggleListFilter,
} from './filters';
import { entry, task } from './test-fixtures';

const TODAY = '2026-11-17';
const planned = (days: number, on = true): BoardFilters => ({
  ...DEFAULT_FILTERS,
  planned: { on, days },
});

describe('cardVisible', () => {
  test('a card planned exactly today + n shows; the day after hides', () => {
    const f = planned(14);
    expect(cardVisible(task('a', { due: '2026-12-01' }), entry(), f, TODAY)).toBe(true);
    expect(cardVisible(task('a', { due: '2026-12-02' }), entry(), f, TODAY)).toBe(false);
  });

  test('a card with no planned date always shows', () => {
    expect(cardVisible(task('a', { due: null }), entry(), planned(1), TODAY)).toBe(true);
  });

  test('an overdue card shows when the date filter is on', () => {
    expect(cardVisible(task('a', { due: '2026-01-01' }), entry(), planned(1), TODAY)).toBe(true);
  });

  test('Done cards ignore the date filter', () => {
    const t = task('a', { due: '2027-06-01' });
    expect(cardVisible(t, entry({ column: 'Done' }), planned(1), TODAY)).toBe(true);
  });

  test('the date filter does nothing while off', () => {
    const t = task('a', { due: '2027-06-01' });
    expect(cardVisible(t, entry(), planned(1, false), TODAY)).toBe(true);
  });

  test('unticked priorities hide their cards; absent priority counts as Medium', () => {
    const f: BoardFilters = {
      ...DEFAULT_FILTERS,
      priorities: new Set(['high', 'medium']),
    };
    expect(cardVisible(task('a'), entry(), f, TODAY)).toBe(true);
    expect(cardVisible(task('a'), entry({ priority: 'high' }), f, TODAY)).toBe(true);
    expect(cardVisible(task('a'), entry({ priority: 'low' }), f, TODAY)).toBe(false);
    const noMedium: BoardFilters = {
      ...DEFAULT_FILTERS,
      priorities: new Set(['high']),
    };
    expect(cardVisible(task('a'), entry(), noMedium, TODAY)).toBe(false);
  });

  test('Done cards still obey the list and priority filters', () => {
    const done = entry({ column: 'Done', priority: 'low' });
    const f: BoardFilters = {
      ...DEFAULT_FILTERS,
      priorities: new Set(['high']),
    };
    expect(cardVisible(task('a'), done, f, TODAY)).toBe(false);
    const lists: BoardFilters = { ...DEFAULT_FILTERS, lists: new Set(['L2']) };
    expect(cardVisible(task('a'), entry({ column: 'Done' }), lists, TODAY)).toBe(false);
  });

  test('list, priority and date filters combine', () => {
    const f: BoardFilters = {
      lists: new Set(['L1']),
      priorities: new Set(['high']),
      planned: { on: true, days: 7 },
    };
    const ok = task('a', { due: '2026-11-20' });
    const high = entry({ priority: 'high' });
    expect(cardVisible(ok, high, f, TODAY)).toBe(true);
    expect(cardVisible(task('a', { listId: 'L2', due: '2026-11-20' }), high, f, TODAY)).toBe(false);
    expect(cardVisible(ok, entry(), f, TODAY)).toBe(false);
    expect(cardVisible(task('a', { due: '2026-12-30' }), high, f, TODAY)).toBe(false);
  });
});

describe('activeFilterCount', () => {
  test('counts the priority group once and the date filter once', () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...DEFAULT_FILTERS, priorities: new Set(['high']) })).toBe(1);
    expect(activeFilterCount({ ...DEFAULT_FILTERS, priorities: new Set() })).toBe(1);
    expect(activeFilterCount(planned(14))).toBe(1);
    expect(
      activeFilterCount({
        ...planned(14),
        priorities: new Set(['low', 'lowest']),
      }),
    ).toBe(2);
  });
});

describe('showOnlyList', () => {
  const all = ['a', 'b', 'c'];

  test('from all lists, shows only the clicked one', () => {
    expect(showOnlyList(null, 'b', all)).toEqual(new Set(['b']));
  });

  test('from a partial selection, shows only the clicked one', () => {
    expect(showOnlyList(new Set(['a', 'c']), 'b', all)).toEqual(new Set(['b']));
  });

  test('clicking the list already shown alone returns to all', () => {
    expect(showOnlyList(new Set(['b']), 'b', all)).toBeNull();
  });

  test('a stale ID in the filter does not stop the return to all', () => {
    expect(showOnlyList(new Set(['b', 'gone']), 'b', all)).toBeNull();
  });

  test('with only one list there is nothing to narrow to', () => {
    expect(showOnlyList(null, 'a', ['a'])).toBeNull();
  });
});

describe('toggleListFilter', () => {
  const all = ['a', 'b', 'c'];

  test('unticking one from all gives all except that one', () => {
    expect(toggleListFilter(null, 'b', all)).toEqual(new Set(['a', 'c']));
  });

  test('ticking the last unticked list returns to all', () => {
    expect(toggleListFilter(new Set(['a', 'c']), 'b', all)).toBeNull();
  });

  test('unticking the only ticked list returns to all, not nothing', () => {
    expect(toggleListFilter(new Set(['a']), 'a', all)).toBeNull();
  });

  test('adds and removes within a partial selection', () => {
    expect(toggleListFilter(new Set(['a']), 'b', all)).toEqual(new Set(['a', 'b']));
    expect(toggleListFilter(new Set(['a', 'b']), 'b', all)).toEqual(new Set(['a']));
  });
});

describe('showNewAccounts', () => {
  const listAccount = { L1: 'a', L2: 'a', T1: 'b', T2: 'b' };

  test("a new account's lists join an active list filter once they arrive", () => {
    expect(showNewAccounts(new Set(['L1']), new Set(['b']), { L1: 'a', L2: 'a' })).toBeNull();
    expect(showNewAccounts(new Set(['L1']), new Set(['b']), listAccount)).toEqual({
      filter: new Set(['L1', 'T1', 'T2']),
      waiting: new Set(),
    });
  });

  test('with no list filter everything shows already, so the wait just ends', () => {
    expect(showNewAccounts(null, new Set(['b']), listAccount)).toEqual({
      filter: null,
      waiting: new Set(),
    });
  });
});
