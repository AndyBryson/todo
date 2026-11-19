import { afterEach, expect, test, vi } from 'vitest';
import { entry, task } from '../domain/test-fixtures';
import type { BoardEntries } from '../domain/types';
import { createFakeGoogle, type FakeGoogle, fakePosition } from '../google/fake';
import type { AccountSet } from './set';
import { harness, memoryStorage, record, syncAll } from './test-fixtures';
import { createWorkspace } from './workspace';

const NOW = '2026-11-19T10:00:00Z';
let running: AccountSet | undefined;

afterEach(() => {
  for (const a of running?.all() ?? []) a.engine.stop();
  running = undefined;
});

async function twoAccounts(seed: { mine?: FakeGoogle; theirs?: FakeGoogle } = {}) {
  const mine =
    seed.mine ??
    createFakeGoogle({
      lists: [{ id: 'L1', title: 'Mine' }],
      tasks: [
        task('p', { title: 'Parent', notes: 'Notes' }),
        task('s1', { parent: 'p', title: 'First', position: fakePosition(0) }),
        task('s2', { parent: 'p', title: 'Second', position: fakePosition(1) }),
      ],
    });
  const theirs =
    seed.theirs ??
    createFakeGoogle({
      lists: [
        { id: 'T0', title: 'My Tasks' },
        { id: 'T1', title: 'Theirs' },
      ],
      account: { email: 'shared@example.com', name: 'Shared' },
    });
  const storage = memoryStorage();
  const { set } = await harness({
    records: [record('a', 'me@example.com'), record('b', 'shared@example.com')],
    storage,
    googles: { a: mine, b: theirs },
  });
  running = set;
  await syncAll(set);
  const ws = createWorkspace(set, storage);
  const a = set.get('a');
  const b = set.get('b');
  if (!a || !b) throw new Error('accounts missing');
  return { set, ws, a, b, mine, theirs, storage };
}

test('a move between accounts deletes the original after the copy lands', async () => {
  const { ws, a, b, mine, theirs } = await twoAccounts();
  expect(ws.canMoveTo('p', 'T1')).toBe('yes');
  await ws.moveToList('p', 'T1', NOW);
  expect(ws.merged().tasks.filter((t) => t.title === 'Parent')).toHaveLength(1);
  expect(
    ws.merged().taskAccount[ws.merged().tasks.find((t) => t.title === 'Parent')?.id ?? ''],
  ).toBe('b');

  await b.engine.syncNow();
  await a.engine.syncNow();

  const copy = [...theirs.tasks.values()].find((t) => t.title === 'Parent');
  expect(copy).toMatchObject({ listId: 'T1', notes: 'Notes', parent: null });
  const steps = [...theirs.tasks.values()]
    .filter((t) => t.parent === copy?.id)
    .sort((x, y) => x.position.localeCompare(y.position))
    .map((t) => t.title);
  expect(steps).toEqual(['First', 'Second']);
  expect([...mine.tasks.keys()]).toEqual([]);
  expect(a.store.snapshot().hidden).toEqual({});
  expect(a.store.snapshot().queueLength).toBe(0);
  expect(ws.merged().tasks.filter((t) => t.title === 'Parent')).toHaveLength(1);
});

test('removing the target mid-move brings the original back', async () => {
  const { set, ws, a } = await twoAccounts();
  await ws.moveToList('p', 'T1', NOW);
  expect(a.store.snapshot().hidden).toEqual({ p: 'b' });

  await set.remove('b');
  expect(a.store.snapshot().hidden).toEqual({});
  expect(ws.merged().taskAccount.p).toBe('a');
  expect(ws.merged().lists.map((l) => l.id)).toEqual(['L1']);
});

test('a copy dropped because its list was deleted brings the original back', async () => {
  const { ws, a, b, mine, theirs } = await twoAccounts();
  await ws.moveToList('p', 'T1', NOW);
  await theirs.deleteTaskList('T1');

  await b.engine.syncNow();
  await vi.waitFor(() => expect(a.store.snapshot().hidden).toEqual({}));
  expect(b.store.snapshot().queueLength).toBe(0);
  expect(a.store.snapshot().queueLength).toBe(0);
  expect(mine.tasks.has('p')).toBe(true);
  expect(ws.merged().taskAccount.p).toBe('a');
});

test('multi-select across accounts keeps board order at the bottom', async () => {
  const mine = createFakeGoogle({
    lists: [{ id: 'L1', title: 'Mine' }],
    tasks: ['a1', 'a2', 'a3'].map((id) => task(id)),
  });
  const theirs = createFakeGoogle({
    lists: [{ id: 'T1', title: 'Theirs' }],
    tasks: ['b1', 'b2', 'b3'].map((id) => task(id, { listId: 'T1' })),
    account: { email: 'shared@example.com', name: 'Shared' },
  });
  const { ws, a, b } = await twoAccounts({ mine, theirs });
  const next = (rank: number) => entry({ column: 'Next', openColumn: 'Next', rank });
  await a.store.commit({
    entries: { a1: entry({ rank: 1 }), a2: entry({ rank: 3 }), a3: next(10) },
  });
  await b.store.commit({
    entries: { b1: entry({ rank: 2 }), b2: entry({ rank: 4 }), b3: next(20) },
  });

  await ws.moveCardsToBottom(['b2', 'a1', 'b1', 'a2'], 'Next', NOW);

  const order = (entries: BoardEntries) =>
    Object.entries(entries)
      .filter(([, e]) => e.column === 'Next')
      .sort(([, x], [, y]) => x.rank - y.rank)
      .map(([id]) => id);
  expect(order(ws.merged().entries)).toEqual(['a3', 'b3', 'a1', 'b1', 'a2', 'b2']);
  expect(Object.keys(a.store.snapshot().entries).sort()).toEqual(['a1', 'a2', 'a3']);
  expect(Object.keys(b.store.snapshot().entries).sort()).toEqual(['b1', 'b2', 'b3']);
});

test('a drop that rebalances writes each card to its own account', async () => {
  const mine = createFakeGoogle({ lists: [{ id: 'L1', title: 'Mine' }], tasks: [task('a1')] });
  const theirs = createFakeGoogle({
    lists: [{ id: 'T1', title: 'Theirs' }],
    tasks: ['b1', 'b2'].map((id) => task(id, { listId: 'T1' })),
    account: { email: 'shared@example.com', name: 'Shared' },
  });
  const { ws, a, b } = await twoAccounts({ mine, theirs });
  const next = (rank: number) => entry({ column: 'Next', openColumn: 'Next', rank });
  await a.store.commit({ entries: { a1: entry({ rank: 1 }) } });
  await b.store.commit({
    entries: { b1: next(1), b2: { ...next(1 + 1e-7), priority: 'high' } },
  });

  await ws.moveCard('a1', 'Next', 'b1', NOW);

  const theirsNow = b.store.snapshot().entries;
  const mineNow = a.store.snapshot().entries;
  expect(mineNow.a1?.rank).toBeGreaterThan(theirsNow.b1?.rank ?? 0);
  expect(mineNow.a1?.rank).toBeLessThan(theirsNow.b2?.rank ?? 0);
  expect(theirsNow.b2).toMatchObject({ priority: 'high', updatedAt: NOW });
  expect(Object.keys(mineNow)).toEqual(['a1']);
});

test("quick add falls back when the last list's account is gone", async () => {
  const { set, ws, a, storage } = await twoAccounts();
  storage.setItem('todo.lastList', JSON.stringify({ accountId: 'b', listId: 'T1' }));
  expect(ws.lastListId()).toBe('T1');

  await set.signOut('b');
  expect(ws.lastListId()).toBe('L1');

  const id = await ws.addTask({ listId: 'L1', title: 'New', pinned: false }, NOW);
  expect(a.store.snapshot().tasks.some((t) => t.id === id)).toBe(true);
  expect(JSON.parse(storage.getItem('todo.lastList') ?? 'null')).toEqual({
    accountId: 'a',
    listId: 'L1',
  });
});

test("an upgraded device's quick add starts from the list it last used", async () => {
  const storage = memoryStorage();
  const { set } = await harness({
    records: [record('a', 'me@example.com'), record('b', 'shared@example.com')],
    storage,
    googles: {
      a: createFakeGoogle({
        lists: [
          { id: 'L1', title: 'Mine' },
          { id: 'L2', title: 'Errands' },
        ],
      }),
      b: createFakeGoogle({
        lists: [{ id: 'T1', title: 'Theirs' }],
        account: { email: 'shared@example.com', name: 'Shared' },
      }),
    },
  });
  running = set;
  await syncAll(set);
  await set.get('a')?.store.setMeta({ lastListId: 'L2' });

  const ws = createWorkspace(set, storage);
  expect(ws.lastListId()).toBe('L2');
  expect(JSON.parse(storage.getItem('todo.lastList') ?? 'null')).toEqual({
    accountId: 'a',
    listId: 'L2',
  });

  // Only once: a list chosen since then is not overwritten by the old one.
  storage.setItem('todo.lastList', JSON.stringify({ accountId: 'b', listId: 'T1' }));
  expect(createWorkspace(set, storage).lastListId()).toBe('T1');
});
