import { expect, test } from 'vitest';
import { DEFAULT_FILTERS } from './filters';
import { entry, task } from './test-fixtures';
import { todaySections } from './today';

// Device in Los Angeles at 20:00 on 17 Nov (04:00 UTC on 18 Nov).
const NOW = new Date('2026-11-18T04:00:00Z');
const TZ = 'America/Los_Angeles';

test('due on the local date is due today, not overdue, across the UTC boundary', () => {
  const s = todaySections([task('t', { due: '2026-11-17' })], {}, NOW, DEFAULT_FILTERS, TZ);
  expect(s.dueToday.map((t) => t.id)).toEqual(['t']);
  expect(s.overdue).toEqual([]);
});

test('due yesterday is overdue; due tomorrow is in neither', () => {
  const s = todaySections(
    [task('y', { due: '2026-11-16' }), task('n', { due: '2026-11-18' })],
    {},
    NOW,
    DEFAULT_FILTERS,
    TZ,
  );
  expect(s.overdue.map((t) => t.id)).toEqual(['y']);
  expect(s.dueToday).toEqual([]);
});

test('pinned tasks show once; overdue wins over pinned; completed never shows', () => {
  const tasks = [task('p'), task('po', { due: '2026-11-01' }), task('pc', { completed: true })];
  const entries = {
    p: entry({ pinned: true }),
    po: entry({ pinned: true }),
    pc: entry({ pinned: true }),
  };
  const s = todaySections(tasks, entries, NOW, DEFAULT_FILTERS, TZ);
  expect(s.pinned.map((t) => t.id)).toEqual(['p']);
  expect(s.overdue.map((t) => t.id)).toEqual(['po']);
});

test('overdue sorts by due date then title; pinned by rank; subtasks excluded', () => {
  const tasks = [
    task('b', { due: '2026-11-10' }),
    task('a', { due: '2026-11-10' }),
    task('c', { due: '2026-11-01' }),
    task('p2'),
    task('p1'),
    task('sub', { due: '2026-11-01', parent: 'a' }),
  ];
  const entries = { p2: entry({ pinned: true, rank: 2 }), p1: entry({ pinned: true, rank: 1 }) };
  const s = todaySections(tasks, entries, NOW, DEFAULT_FILTERS, TZ);
  expect(s.overdue.map((t) => t.id)).toEqual(['c', 'a', 'b']);
  expect(s.pinned.map((t) => t.id)).toEqual(['p1', 'p2']);
});

test('pinned sorts by column, left to right, then by rank within a column', () => {
  const tasks = [task('next1'), task('doing'), task('backlog9'), task('next2')];
  const entries = {
    next1: entry({ pinned: true, column: 'Next', openColumn: 'Next', rank: 1 }),
    doing: entry({ pinned: true, column: 'Doing', openColumn: 'Doing', rank: 0 }),
    backlog9: entry({ pinned: true, column: 'Backlog', rank: 9 }),
    next2: entry({ pinned: true, column: 'Next', openColumn: 'Next', rank: 2 }),
  };
  const s = todaySections(tasks, entries, NOW, DEFAULT_FILTERS, TZ);
  expect(s.pinned.map((t) => t.id)).toEqual(['backlog9', 'next1', 'next2', 'doing']);
});

test('Today leaves out tasks in hidden lists and hidden priorities', () => {
  const tasks = [
    task('home', { listId: 'L1', due: '2026-11-17' }),
    task('work', { listId: 'L2', due: '2026-11-17' }),
    task('low', { listId: 'L1', due: '2026-11-17' }),
  ];
  const entries = { home: entry(), work: entry(), low: entry({ priority: 'low' }) };
  const filters = {
    ...DEFAULT_FILTERS,
    lists: new Set(['L1']),
    priorities: new Set(['highest', 'high', 'medium'] as const),
  };
  expect(todaySections(tasks, entries, NOW, filters, TZ).dueToday.map((t) => t.id)).toEqual([
    'home',
  ]);
});

test('the planned-date filter never hides tasks on Today', () => {
  const tasks = [task('late', { due: '2026-11-01' }), task('now', { due: '2026-11-17' })];
  const filters = { ...DEFAULT_FILTERS, planned: { on: true, days: 1 } };
  const s = todaySections(tasks, { late: entry(), now: entry() }, NOW, filters, TZ);
  expect(s.overdue.map((t) => t.id)).toEqual(['late']);
  expect(s.dueToday.map((t) => t.id)).toEqual(['now']);
});

test('a task with no board entry counts as Medium', () => {
  const tasks = [task('new', { due: '2026-11-17' })];
  expect(todaySections(tasks, {}, NOW, DEFAULT_FILTERS, TZ).dueToday.map((t) => t.id)).toEqual([
    'new',
  ]);
  const noMedium = { ...DEFAULT_FILTERS, priorities: new Set(['high', 'low'] as const) };
  expect(todaySections(tasks, {}, NOW, noMedium, TZ).dueToday).toEqual([]);
});
