import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../store/db';
import { type AccountView, combineStatus, mergeViews } from './merge';
import { entry, task } from './test-fixtures';

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    lists: [],
    tasks: [],
    entries: {},
    queueLength: 0,
    queued: [],
    notices: [],
    lastSyncedAt: null,
    lastListId: null,
    defaultListId: null,
    renamed: {},
    hidden: {},
    ...overrides,
  };
}

function view(id: string, label: string, overrides: Partial<Snapshot> = {}): AccountView {
  return { id, label, snapshot: snap(overrides) };
}

describe('mergeViews', () => {
  it('merges two accounts and records ownership', () => {
    const a = view('a', 'Home', {
      lists: [{ id: 'LA', title: 'Home list' }],
      tasks: [task('ta', { listId: 'LA' })],
      entries: { ta: entry() },
      queueLength: 2,
      notices: [{ id: 'n1', text: 'one' }],
    });
    const b = view('b', 'Work', {
      lists: [{ id: 'LB', title: 'Work list' }],
      tasks: [task('tb', { listId: 'LB' })],
      entries: { tb: entry({ rank: 2048 }) },
      queueLength: 3,
      notices: [{ id: 'n2', text: 'two' }],
    });
    const m = mergeViews([a, b]);
    expect(m.tasks.map((t) => t.id)).toEqual(['ta', 'tb']);
    expect(m.lists.map((l) => l.id)).toEqual(['LA', 'LB']);
    expect(Object.keys(m.entries)).toEqual(['ta', 'tb']);
    expect(m.taskAccount).toEqual({ ta: 'a', tb: 'b' });
    expect(m.listAccount).toEqual({ LA: 'a', LB: 'b' });
    expect(m.queueLength).toBe(5);
    expect(m.notices).toEqual([
      { id: 'n1', text: 'one', accountId: 'a' },
      { id: 'n2', text: 'two', accountId: 'b' },
    ]);
  });

  it('a hidden task leaves with its steps and entry', () => {
    const a = view('a', 'Home', {
      lists: [{ id: 'LA', title: 'Home list' }],
      tasks: [
        task('moving', { listId: 'LA' }),
        task('step', { listId: 'LA', parent: 'moving' }),
        task('stay', { listId: 'LA' }),
      ],
      entries: { moving: entry(), stay: entry() },
      hidden: { moving: 'b' },
    });
    const m = mergeViews([a]);
    expect(m.tasks.map((t) => t.id)).toEqual(['stay']);
    expect(Object.keys(m.entries)).toEqual(['stay']);
    expect(m.taskAccount).toEqual({ stay: 'a' });
  });

  it('clashing list names get the account label', () => {
    const a = view('a', 'Home', {
      lists: [
        { id: 'LA1', title: 'My Tasks' },
        { id: 'LA2', title: 'Work' },
      ],
    });
    const b = view('b', 'Job', { lists: [{ id: 'LB1', title: 'My Tasks' }] });
    const m = mergeViews([a, b]);
    expect(m.listName).toEqual({
      LA1: 'My Tasks · Home',
      LA2: 'Work',
      LB1: 'My Tasks · Job',
    });
  });

  it('two lists with one name in a single account stay plain', () => {
    const a = view('a', 'Home', {
      lists: [
        { id: 'L1', title: 'Work' },
        { id: 'L2', title: 'Work' },
      ],
    });
    const b = view('b', 'Job', { lists: [{ id: 'LB', title: 'Other' }] });
    expect(mergeViews([a, b]).listName).toEqual({ L1: 'Work', L2: 'Work', LB: 'Other' });
  });
});

describe('combineStatus', () => {
  it('status names every account needing sign-in', () => {
    const r = combineStatus([
      { label: 'Home', status: { kind: 'signin' } },
      { label: 'Work', status: { kind: 'offline' } },
      { label: 'Spare', status: { kind: 'signin' } },
    ]);
    expect(r.signIn).toEqual(['Home', 'Spare']);
    expect(r.status).toEqual({ kind: 'offline' });
  });

  it('ranks error, offline, syncing, idle, synced and keeps the first error', () => {
    const e = (message: string) => ({ kind: 'error' as const, message });
    expect(
      combineStatus([
        { label: 'a', status: { kind: 'offline' } },
        { label: 'b', status: e('first') },
        { label: 'c', status: e('second') },
      ]).status,
    ).toEqual(e('first'));
    expect(
      combineStatus([
        { label: 'a', status: { kind: 'idle' } },
        { label: 'b', status: { kind: 'syncing' } },
      ]).status,
    ).toEqual({ kind: 'syncing' });
    expect(
      combineStatus([
        { label: 'a', status: { kind: 'synced', at: '2026-11-19T10:00:00Z' } },
        { label: 'b', status: { kind: 'idle' } },
      ]).status,
    ).toEqual({ kind: 'idle' });
  });

  it('synced reports the oldest time', () => {
    const r = combineStatus([
      { label: 'a', status: { kind: 'synced', at: '2026-11-19T10:00:00.000Z' } },
      { label: 'b', status: { kind: 'synced', at: '2026-11-19T08:00:00.000Z' } },
    ]);
    expect(r).toEqual({
      status: { kind: 'synced', at: '2026-11-19T08:00:00.000Z' },
      signIn: [],
    });
  });

  it('an empty list is idle', () => {
    expect(combineStatus([])).toEqual({ status: { kind: 'idle' }, signIn: [] });
  });
});
