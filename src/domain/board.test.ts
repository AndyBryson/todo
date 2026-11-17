import { describe, expect, test } from 'vitest';
import {
  completeEntry,
  mergeEntries,
  parseBoardFile,
  reconcile,
  reopenEntry,
  serialiseBoard,
} from './board';
import type { BoardEntry, Task, TaskList } from './types';

const NOW = '2026-11-17T12:00:00Z';
const OLD = '2026-11-01T00:00:00Z';
const LISTS: TaskList[] = [{ id: 'L1', title: 'Home' }];

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    listId: 'L1',
    title: id,
    notes: '',
    due: null,
    completed: false,
    completedAt: null,
    parent: null,
    position: '0',
    updated: OLD,
    ...overrides,
  };
}

function entry(overrides: Partial<BoardEntry> = {}): BoardEntry {
  return {
    column: 'Backlog',
    rank: 1024,
    pinned: false,
    openColumn: 'Backlog',
    updatedAt: OLD,
    ...overrides,
  };
}

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

  test('positions compare numerically, not as text', () => {
    const tasks = [task('ten', { position: '10' }), task('nine', { position: '9' })];
    const out = reconcile(tasks, LISTS, {}, NOW);
    expect(out.nine?.rank).toBeLessThan(out.ten?.rank ?? 0);
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
    const { updatedAt: _omit, ...noStamp } = entry();
    const raw = JSON.stringify({
      version: 1,
      entries: {
        ok: entry(),
        pin: { ...entry(), pinned: 'yes' },
        done: { ...entry(), openColumn: 'Done' },
        stamp: noStamp,
        rank: { ...entry(), rank: null },
      },
    });
    expect(Object.keys(parseBoardFile(raw))).toEqual(['ok']);
  });

  test('round-trips through serialiseBoard', () => {
    const entries = { a: entry({ column: 'Doing', pinned: true, openColumn: 'Next' }) };
    expect(parseBoardFile(serialiseBoard(entries))).toEqual(entries);
  });
});
