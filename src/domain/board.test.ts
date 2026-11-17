import { describe, expect, test } from 'vitest';
import {
  buildBoard,
  completeEntry,
  listColour,
  mergeEntries,
  parseBoardFile,
  placeInColumn,
  priorityOf,
  reconcile,
  reopenEntry,
  serialiseBoard,
} from './board';
import { entry, OLD, task } from './test-fixtures';
import type { BoardEntries, Column, TaskList } from './types';

const NOW = '2026-11-17T12:00:00Z';
const LISTS: TaskList[] = [{ id: 'L1', title: 'Home' }];

describe('reconcile', () => {
  test('first run puts every open task in Backlog in Google order across lists', () => {
    const lists = [
      { id: 'L1', title: 'Home' },
      { id: 'L2', title: 'Work' },
    ];
    const tasks = [
      task('b', { listId: 'L1', position: '2' }),
      task('a', { listId: 'L1', position: '1' }),
      task('c', { listId: 'L2', position: '0' }),
    ];
    const out = reconcile(tasks, lists, {}, NOW);
    const order = Object.entries(out)
      .sort(([, x], [, y]) => x.rank - y.rank)
      .map(([id]) => id);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(Object.values(out).every((e) => e.column === 'Backlog' && !e.pinned)).toBe(true);
  });

  test('positions that differ only in the last of 20 digits keep their order', () => {
    const tasks = [
      task('later', { position: '00000000000000000010' }),
      task('earlier', { position: '00000000000000000009' }),
    ];
    const out = reconcile(tasks, LISTS, {}, NOW);
    expect(out.earlier?.rank).toBeLessThan(out.later?.rank ?? 0);
  });

  test('a task created in Google Home lands at the bottom of Backlog', () => {
    const entries = { x: entry({ column: 'Backlog', rank: 5000 }) };
    const out = reconcile([task('x'), task('new')], LISTS, entries, NOW);
    expect(out.new?.column).toBe('Backlog');
    expect(out.new?.rank).toBeGreaterThan(5000);
  });

  test('several new tasks in one pull each land below the previous', () => {
    const tasks = [task('a', { position: '1' }), task('b', { position: '2' })];
    const out = reconcile(tasks, LISTS, {}, NOW);
    expect(out.b?.rank).toBeGreaterThan(out.a?.rank ?? Number.POSITIVE_INFINITY);
  });

  test('a new task already completed goes straight to Done, unpinned', () => {
    const out = reconcile([task('x', { completed: true, completedAt: NOW })], LISTS, {}, NOW);
    expect(out.x).toMatchObject({ column: 'Done', openColumn: 'Backlog', pinned: false });
  });

  test('completed in Google moves to Done, remembers its column, clears the pin', () => {
    const out = reconcile(
      [task('x', { completed: true, completedAt: NOW })],
      LISTS,
      { x: entry({ column: 'Doing', pinned: true }) },
      NOW,
    );
    expect(out.x).toMatchObject({
      column: 'Done',
      openColumn: 'Doing',
      pinned: false,
      updatedAt: NOW,
    });
  });

  test('reopened in Google returns to its previous column at the bottom', () => {
    const entries = {
      y: entry({ column: 'Waiting', rank: 9000 }),
      x: entry({ column: 'Done', openColumn: 'Waiting' }),
    };
    const out = reconcile([task('x'), task('y')], LISTS, entries, NOW);
    expect(out.x?.column).toBe('Waiting');
    expect(out.x?.rank).toBeGreaterThan(9000);
  });

  test('entry for a deleted task is pruned; subtasks get no entry', () => {
    const out = reconcile(
      [task('p'), task('s', { parent: 'p' })],
      LISTS,
      { p: entry(), gone: entry() },
      NOW,
    );
    expect(Object.keys(out).sort()).toEqual(['p']);
  });

  test('untouched entries keep their updatedAt', () => {
    const out = reconcile([task('x')], LISTS, { x: entry({ column: 'Next' }) }, NOW);
    expect(out.x?.updatedAt).toBe(OLD);
  });
});

describe('completeEntry and reopenEntry', () => {
  test('completing an already-Done entry keeps its remembered column', () => {
    const done = entry({ column: 'Done', openColumn: 'Next' });
    expect(completeEntry(done, NOW).openColumn).toBe('Next');
  });

  test('reopening ignores the entry itself when ranking the target column', () => {
    const e = entry({ column: 'Done', openColumn: 'Next', rank: 99999 });
    const out = reopenEntry(e, { a: entry({ column: 'Next', rank: 2048 }), self: e }, NOW);
    expect(out.rank).toBe(3072);
  });
});

describe('mergeEntries', () => {
  test('keeps the newer entry per task and the union of both', () => {
    const local = { a: entry({ column: 'Next', updatedAt: '2026-11-17T10:00:00Z' }), b: entry() };
    const remote = { a: entry({ column: 'Doing', updatedAt: '2026-11-17T09:00:00Z' }), c: entry() };
    const out = mergeEntries(local, remote);
    expect(out.a?.column).toBe('Next');
    expect(Object.keys(out).sort()).toEqual(['a', 'b', 'c']);
  });

  test('compares instants: fractional seconds and offsets', () => {
    const fractional = mergeEntries(
      { a: entry({ column: 'Next', updatedAt: '2026-11-17T10:00:00.500Z' }) },
      { a: entry({ column: 'Doing', updatedAt: '2026-11-17T10:00:00Z' }) },
    );
    expect(fractional.a?.column).toBe('Next');
    // 10:30+01:00 is 09:30Z, earlier than 10:00Z despite sorting later as text.
    const offset = mergeEntries(
      { a: entry({ column: 'Next', updatedAt: '2026-11-17T10:00:00Z' }) },
      { a: entry({ column: 'Doing', updatedAt: '2026-11-17T10:30:00+01:00' }) },
    );
    expect(offset.a?.column).toBe('Next');
  });

  test('a tie keeps the remote entry', () => {
    const out = mergeEntries({ a: entry({ column: 'Next' }) }, { a: entry({ column: 'Doing' }) });
    expect(out.a?.column).toBe('Doing');
  });
});

describe('parseBoardFile', () => {
  test('missing or malformed board.json reads as empty and bad entries are skipped', () => {
    expect(parseBoardFile(null)).toEqual({});
    expect(parseBoardFile('')).toEqual({});
    expect(parseBoardFile('{not json')).toEqual({});
    expect(parseBoardFile('{"version":2,"entries":{}}')).toEqual({});
    const raw = JSON.stringify({
      version: 1,
      entries: { ok: entry(), bad: { column: 'Someday', rank: 1 } },
    });
    expect(Object.keys(parseBoardFile(raw))).toEqual(['ok']);
  });

  test('skips entries with a bad pin, openColumn of Done, or no updatedAt', () => {
    const noStamp = { ...entry(), updatedAt: undefined };
    const raw = JSON.stringify({
      version: 1,
      entries: {
        ok: entry(),
        pin: { ...entry(), pinned: 'yes' },
        done: { ...entry(), openColumn: 'Done' },
        stamp: noStamp,
        rank: { ...entry(), rank: null },
        garbage: { ...entry(), updatedAt: 'z' },
        blank: { ...entry(), updatedAt: '' },
      },
    });
    expect(Object.keys(parseBoardFile(raw))).toEqual(['ok']);
  });

  test('round-trips through serialiseBoard', () => {
    const entries = { a: entry({ column: 'Doing', pinned: true, openColumn: 'Next' }) };
    expect(parseBoardFile(serialiseBoard(entries))).toEqual(entries);
  });
});

function orderOf(entries: BoardEntries, column: Column): string[] {
  return Object.entries(entries)
    .filter(([, e]) => e.column === column)
    .sort(([, a], [, b]) => a.rank - b.rank)
    .map(([id]) => id);
}

describe('buildBoard', () => {
  const now = new Date('2026-11-17T12:00:00Z');

  test('Done shows only the last 7 days, newest first', () => {
    const tasks = [
      task('old', { completed: true, completedAt: '2026-11-10T11:00:00Z' }),
      task('a', { completed: true, completedAt: '2026-11-16T09:00:00Z' }),
      task('b', { completed: true, completedAt: '2026-11-17T09:00:00Z' }),
    ];
    const entries = {
      old: entry({ column: 'Done' }),
      a: entry({ column: 'Done' }),
      b: entry({ column: 'Done' }),
    };
    expect(buildBoard(tasks, LISTS, entries, null, now).Done.map((c) => c.task.id)).toEqual([
      'b',
      'a',
    ]);
  });

  test('open columns are sorted by rank, and subtasks and entry-less tasks are left out', () => {
    const tasks = [task('x'), task('y'), task('sub', { parent: 'x' }), task('bare')];
    const entries = {
      x: entry({ column: 'Next', rank: 2 }),
      y: entry({ column: 'Next', rank: 1 }),
      sub: entry({ column: 'Next', rank: 0 }),
    };
    expect(buildBoard(tasks, LISTS, entries, null, now).Next.map((c) => c.task.id)).toEqual([
      'y',
      'x',
    ]);
  });

  test('filter keeps only chosen lists', () => {
    const lists = [
      { id: 'L1', title: 'Home' },
      { id: 'L2', title: 'Work' },
    ];
    const tasks = [task('h', { listId: 'L1' }), task('w', { listId: 'L2' })];
    const entries = { h: entry({ rank: 1 }), w: entry({ rank: 2 }) };
    const board = buildBoard(tasks, lists, entries, new Set(['L2']), now);
    expect(board.Backlog.map((c) => c.task.id)).toEqual(['w']);
    expect(board.Backlog[0]?.list.title).toBe('Work');
  });
});

describe('placeInColumn', () => {
  test('dropping under a visible card skips hidden cards and leaves them in order', () => {
    // Backlog order: v1(L1) h1(L2) h2(L2) v2(L1) m(L1). Filtered to L1, m is dropped right under v1.
    const entries = {
      v1: entry({ rank: 1 }),
      h1: entry({ rank: 2 }),
      h2: entry({ rank: 3 }),
      v2: entry({ rank: 4 }),
      m: entry({ rank: 5 }),
    };
    const merged = { ...entries, ...placeInColumn(entries, 'm', 'Backlog', 'v1') };
    expect(orderOf(merged, 'Backlog')).toEqual(['v1', 'm', 'h1', 'h2', 'v2']);
  });

  test('a drop that forces a rebalance keeps hidden cards in order', () => {
    const entries = {
      v1: entry({ rank: 1 }),
      h1: entry({ rank: 1 + 1e-9 }),
      v2: entry({ rank: 3 }),
      m: entry({ rank: 4 }),
    };
    const changes = placeInColumn(entries, 'm', 'Backlog', 'v1');
    expect(Object.keys(changes).sort()).toEqual(['h1', 'm', 'v1', 'v2']);
    const merged = { ...entries, ...changes };
    expect(orderOf(merged, 'Backlog')).toEqual(['v1', 'm', 'h1', 'v2']);
  });

  test('null puts the card at the top, even from another column', () => {
    const entries = {
      a: entry({ column: 'Next', rank: 5 }),
      m: entry({ column: 'Doing', rank: 1 }),
    };
    const changes = placeInColumn(entries, 'm', 'Next', null);
    expect(Object.keys(changes)).toEqual(['m']);
    expect(changes.m?.column).toBe('Next');
    expect(orderOf({ ...entries, ...changes }, 'Next')).toEqual(['m', 'a']);
  });

  test('an insertAfter that is not in the column counts as the top', () => {
    const entries = { a: entry({ rank: 5 }), m: entry({ column: 'Next', rank: 1 }) };
    const merged = { ...entries, ...placeInColumn(entries, 'm', 'Backlog', 'ghost') };
    expect(orderOf(merged, 'Backlog')).toEqual(['m', 'a']);
  });
});

describe('listColour', () => {
  test('is stable for an ID and differs between IDs', () => {
    expect(listColour('MTIzNDU')).toBe(listColour('MTIzNDU'));
    const colours = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map(listColour));
    expect(colours.size).toBeGreaterThan(1);
  });
});

describe('step counts', () => {
  const entries: BoardEntries = { p: entry() };
  const cardFor = (tasks: ReturnType<typeof task>[]) =>
    buildBoard(tasks, LISTS, entries, null, new Date(NOW)).Backlog[0];

  test('a card counts its done and total steps', () => {
    const card = cardFor([
      task('p'),
      task('s1', { parent: 'p', completed: true, completedAt: OLD }),
      task('s2', { parent: 'p' }),
      task('s3', { parent: 'p' }),
    ]);
    expect(card?.steps).toEqual({ done: 1, total: 3 });
  });

  test('a card with no subtasks has no step count', () => {
    expect(cardFor([task('p')])?.steps).toBeNull();
  });
});

describe('board file priority and unknown fields', () => {
  // Captured from the serialiser before priority existed: devices compare this
  // text to decide whether to rewrite board.json, so its format must not drift.
  const EXISTING =
    '{"version":1,"entries":{"a":{"column":"Backlog","rank":1024,"pinned":false,"openColumn":"Backlog","updatedAt":"2026-11-01T00:00:00Z"},"b":{"column":"Next","rank":1024,"pinned":false,"openColumn":"Next","updatedAt":"2026-11-01T00:00:00Z"}}}';

  test('an existing board file reads and writes back byte for byte', () => {
    expect(serialiseBoard(parseBoardFile(EXISTING))).toBe(EXISTING);
    expect(serialiseBoard({ b: entry({ column: 'Next', openColumn: 'Next' }), a: entry() })).toBe(
      EXISTING,
    );
  });

  test('a priority round-trips', () => {
    const out = parseBoardFile(serialiseBoard({ a: entry({ priority: 'low' }) }));
    expect(out.a?.priority).toBe('low');
    expect(priorityOf(out.a ?? entry())).toBe('low');
  });

  test('an unknown entry field survives parse, merge and serialise', () => {
    const raw = JSON.stringify({
      version: 1,
      entries: { a: { ...entry(), colour: 'teal', zeta: [1], alpha: { n: 1 } } },
    });
    const parsed = parseBoardFile(raw);
    const merged = mergeEntries(parsed, {});
    const written = JSON.parse(serialiseBoard(merged)).entries.a;
    expect(written.colour).toBe('teal');
    expect(written.zeta).toEqual([1]);
    expect(Object.keys(written).slice(5)).toEqual(['alpha', 'colour', 'zeta']);
  });

  test('priority is written after the known fields and before unknown ones', () => {
    const e = { ...entry({ priority: 'high' }), extra: { colour: 'teal' } };
    const written = JSON.parse(serialiseBoard({ a: e })).entries.a;
    expect(Object.keys(written)).toEqual([
      'column',
      'rank',
      'pinned',
      'openColumn',
      'updatedAt',
      'priority',
      'colour',
    ]);
  });

  test('an invalid or medium priority reads as Medium and keeps the entry', () => {
    for (const bad of ['urgent', 'medium', 3, null]) {
      const raw = JSON.stringify({ version: 1, entries: { a: { ...entry(), priority: bad } } });
      const out = parseBoardFile(raw);
      expect(out.a).toBeDefined();
      expect(priorityOf(out.a ?? entry())).toBe('medium');
      expect(serialiseBoard(out)).not.toContain('priority');
    }
  });

  test('priority and unknown fields survive completing and reopening', () => {
    const e = { ...entry({ column: 'Next', priority: 'highest' }), extra: { colour: 'teal' } };
    const done = completeEntry(e, NOW);
    expect(done.priority).toBe('highest');
    expect(done.extra).toEqual({ colour: 'teal' });
    const back = reopenEntry(done, { a: done }, NOW);
    expect(back.priority).toBe('highest');
    expect(back.extra).toEqual({ colour: 'teal' });
  });

  test('placing and reconciling keep priority and unknown fields', () => {
    const e = { ...entry({ priority: 'lowest' }), extra: { colour: 'teal' } };
    const placed = placeInColumn({ a: e }, 'a', 'Next', null).a;
    expect(placed?.priority).toBe('lowest');
    expect(placed?.extra).toEqual({ colour: 'teal' });
    const out = reconcile([task('a', { completed: true, completedAt: NOW })], LISTS, { a: e }, NOW);
    expect(out.a?.priority).toBe('lowest');
    expect(out.a?.extra).toEqual({ colour: 'teal' });
  });

  test('a newer priority change on one device wins the merge', () => {
    const local = { a: entry({ priority: 'low', updatedAt: '2026-11-02T00:00:00Z' }) };
    const remote = { a: entry({ priority: 'high', updatedAt: '2026-11-03T00:00:00Z' }) };
    expect(mergeEntries(local, remote).a?.priority).toBe('high');
    expect(mergeEntries(remote, local).a?.priority).toBe('high');
  });
});
