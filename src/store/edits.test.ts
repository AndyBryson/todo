import { beforeEach, describe, expect, test } from 'vitest';
import { entry, task } from '../domain/test-fixtures';
import { openStore, type Store } from './db';
import { addTask, deleteTask, editTask, moveCard, moveToList } from './edits';

const NOW = '2026-11-17T10:00:00Z';
let store: Store;
let name: string;

beforeEach(async () => {
  name = `test-${crypto.randomUUID()}`;
  store = await openStore(name);
  await store.replaceRemote(
    [
      { id: 'L1', title: 'One' },
      { id: 'L2', title: 'Two' },
    ],
    [task('x')],
  );
});

const ops = async () => (await store.queue()).map((q) => q.op);

test('dragging to Done completes the task in Google and clears the pin', async () => {
  await store.setEntries({ x: entry({ column: 'Doing', openColumn: 'Doing', pinned: true }) });
  await moveCard(store, 'x', 'Done', null, NOW);
  const s = store.snapshot();
  expect(s.entries.x).toMatchObject({ column: 'Done', openColumn: 'Doing', pinned: false });
  expect(await ops()).toEqual([
    {
      kind: 'patch',
      listId: 'L1',
      taskId: 'x',
      set: { completed: true },
      base: { completed: false },
    },
  ]);
});

test('dragging out of Done reopens the task in Google', async () => {
  await store.putTask(task('x', { completed: true, completedAt: OLD_DONE }));
  await store.setEntries({ x: entry({ column: 'Done', openColumn: 'Next' }) });
  await moveCard(store, 'x', 'Waiting', null, NOW);
  const s = store.snapshot();
  expect(s.entries.x).toMatchObject({ column: 'Waiting', openColumn: 'Waiting' });
  expect(s.tasks.find((t) => t.id === 'x')).toMatchObject({ completed: false, completedAt: null });
  expect(await ops()).toEqual([
    {
      kind: 'patch',
      listId: 'L1',
      taskId: 'x',
      set: { completed: false },
      base: { completed: true },
    },
  ]);
});

const OLD_DONE = '2026-11-10T00:00:00Z';

test('moving between open columns places the card and queues nothing', async () => {
  await store.putTask(task('a'));
  await store.setEntries({
    x: entry({ column: 'Next', openColumn: 'Next', rank: 1024 }),
    a: entry({ column: 'Doing', openColumn: 'Doing', rank: 1024 }),
  });
  await moveCard(store, 'x', 'Doing', 'a', NOW);
  const { entries } = store.snapshot();
  expect(entries.x).toMatchObject({ column: 'Doing', openColumn: 'Doing', updatedAt: NOW });
  expect(entries.x?.rank).toBeGreaterThan(entries.a?.rank ?? 0);
  expect(await ops()).toEqual([]);
});

test('quick add from Today pins it and puts it at the bottom of Backlog in the chosen list', async () => {
  await store.setEntries({ x: entry({ rank: 5000 }) });
  const id = await addTask(store, { listId: 'L2', title: '  Buy milk ', pinned: true }, NOW);
  const s = store.snapshot();
  expect(s.tasks.find((t) => t.id === id)?.title).toBe('Buy milk');
  expect(s.entries[id]).toMatchObject({ column: 'Backlog', pinned: true });
  expect(s.entries[id]?.rank).toBeGreaterThan(5000);
  expect(s.lastListId).toBe('L2');
  expect(await ops()).toEqual([
    { kind: 'create', listId: 'L2', tempId: id, task: { title: 'Buy milk' } },
  ]);
});

test('blank quick add is refused', async () => {
  await expect(
    addTask(store, { listId: 'L1', title: '   ', pinned: false }, NOW),
  ).rejects.toThrow();
  expect(await ops()).toEqual([]);
});

test('an edit records the previous values as the patch base', async () => {
  await store.putTask(task('x', { title: 'Old', due: '2026-11-20' }));
  await editTask(store, 'x', { title: 'New', due: null });
  expect(await ops()).toEqual([
    {
      kind: 'patch',
      listId: 'L1',
      taskId: 'x',
      set: { title: 'New', due: null },
      base: { title: 'Old', due: '2026-11-20' },
    },
  ]);
});

test('moving to another list takes subtasks along and queues the old list', async () => {
  await store.putTask(task('sub', { parent: 'x' }));
  await moveToList(store, 'x', 'L2');
  const s = store.snapshot();
  expect(
    s.tasks
      .filter((t) => t.listId === 'L2')
      .map((t) => t.id)
      .sort(),
  ).toEqual(['sub', 'x']);
  expect(await ops()).toEqual([{ kind: 'move', listId: 'L1', taskId: 'x', toListId: 'L2' }]);
});

test('deleting removes the task, subtasks and card and queues one delete', async () => {
  await store.putTask(task('sub', { parent: 'x' }));
  await store.setEntries({ x: entry() });
  await deleteTask(store, 'x');
  const s = store.snapshot();
  expect(s.tasks).toEqual([]);
  expect(s.entries).toEqual({});
  expect(await ops()).toEqual([{ kind: 'delete', listId: 'L1', taskId: 'x' }]);
});

describe('unknown ids', () => {
  test('every edit throws', async () => {
    await expect(editTask(store, 'nope', { title: 'a' })).rejects.toThrow();
    await expect(moveCard(store, 'nope', 'Next', null, NOW)).rejects.toThrow();
    await expect(moveToList(store, 'nope', 'L2')).rejects.toThrow();
    await expect(deleteTask(store, 'nope')).rejects.toThrow();
  });
});

describe('store', () => {
  test('survives a reopen', async () => {
    await store.setEntries({ x: entry({ column: 'Next', openColumn: 'Next' }) });
    await store.enqueue({ kind: 'delete', listId: 'L1', taskId: 'x' });
    await store.enqueue({ kind: 'delete', listId: 'L1', taskId: 'y' });
    await store.setMeta({ lastListId: 'L2' });

    const reopened = await openStore(name);
    const s = reopened.snapshot();
    expect(s.tasks.map((t) => t.id)).toEqual(['x']);
    expect(s.entries.x?.column).toBe('Next');
    expect(s.lastListId).toBe('L2');
    expect(s.queueLength).toBe(2);
    const queued = await reopened.queue();
    expect(queued.map((q) => q.seq)).toEqual([...queued.map((q) => q.seq)].sort((a, b) => a - b));
    expect(queued.map((q) => q.op)).toEqual([
      { kind: 'delete', listId: 'L1', taskId: 'x' },
      { kind: 'delete', listId: 'L1', taskId: 'y' },
    ]);
  });

  test('snapshot identity changes only on writes and subscribers are told', async () => {
    const before = store.snapshot();
    expect(store.snapshot()).toBe(before);
    let calls = 0;
    store.subscribe(() => calls++);
    await store.addNotice('hello');
    expect(store.snapshot()).not.toBe(before);
    expect(store.snapshot().tasks).toBe(before.tasks);
    expect(calls).toBe(1);
  });

  test('renaming a task moves its entry and queued ops', async () => {
    await store.setEntries({ x: entry() });
    await store.enqueue({ kind: 'delete', listId: 'L1', taskId: 'x' });
    await store.renameTask('x', 'real');
    const s = store.snapshot();
    expect(s.tasks.map((t) => t.id)).toEqual(['real']);
    expect(Object.keys(s.entries)).toEqual(['real']);
    expect(await ops()).toEqual([{ kind: 'delete', listId: 'L1', taskId: 'real' }]);
  });
});
