import { beforeEach, expect, test } from 'vitest';
import { entry, task } from '../domain/test-fixtures';
import { HttpError } from '../google/api';
import { createFakeGoogle, type FakeGoogle } from '../google/fake';
import { openStore, type Store } from '../store/db';
import { BlankNameError, createList, deleteList, renameList } from './lists';

const LISTS = [
  { id: 'L1', title: 'My Tasks' },
  { id: 'L2', title: 'Packing' },
];
let store: Store;
let google: FakeGoogle;

beforeEach(async () => {
  store = await openStore(`test-${crypto.randomUUID()}`);
  const tasks = [
    task('a', { listId: 'L1' }),
    task('p', { listId: 'L2' }),
    task('s', { listId: 'L2', parent: 'p' }),
    task('q', { listId: 'L2' }),
  ];
  await store.commit({
    replaceRemote: { lists: LISTS, tasks },
    replaceEntries: { a: entry(), p: entry(), q: entry() },
  });
  google = createFakeGoogle({ lists: LISTS, tasks });
});

test('createList adds the list in Google and the mirror', async () => {
  const list = await createList(google, store, '  Garden  ');
  expect(list.title).toBe('Garden');
  expect(google.lists.map((l) => l.title)).toContain('Garden');
  expect(store.snapshot().lists).toContainEqual(list);
});

test('renameList renames in Google and the mirror', async () => {
  await renameList(google, store, 'L2', 'Holiday');
  expect(google.lists.find((l) => l.id === 'L2')?.title).toBe('Holiday');
  expect(store.snapshot().lists.find((l) => l.id === 'L2')?.title).toBe('Holiday');
});

test('a blank name is refused without calling Google', async () => {
  await expect(createList(google, store, '   ')).rejects.toBeInstanceOf(BlankNameError);
  await expect(renameList(google, store, 'L2', '')).rejects.toBeInstanceOf(BlankNameError);
  expect(google.calls).toEqual([]);
  expect(store.snapshot().lists).toEqual(LISTS);
});

test('deleteList removes the list, its tasks and steps, their entries and queued writes', async () => {
  await store.commit({
    enqueue: [
      { kind: 'patch', listId: 'L2', taskId: 'p', set: { title: 'P' }, base: { title: 'p' } },
      { kind: 'delete', listId: 'L2', taskId: 'q' },
    ],
  });
  await deleteList(google, store, 'L2');
  const s = store.snapshot();
  expect(google.lists.map((l) => l.id)).toEqual(['L1']);
  expect(s.lists.map((l) => l.id)).toEqual(['L1']);
  expect(s.tasks.map((t) => t.id)).toEqual(['a']);
  expect(Object.keys(s.entries)).toEqual(['a']);
  expect(s.queued).toEqual([]);
});

test('deleteList keeps queued writes for other lists', async () => {
  await store.commit({
    enqueue: [
      { kind: 'patch', listId: 'L1', taskId: 'a', set: { title: 'A' }, base: { title: 'a' } },
      { kind: 'move', listId: 'L1', taskId: 'a', toListId: 'L2' },
    ],
  });
  await deleteList(google, store, 'L2');
  expect(store.snapshot().queued.map((q) => q.op.kind)).toEqual(['patch']);
});

test('deleteList forgets the remembered Quick add list', async () => {
  await store.setMeta({ lastListId: 'L2' });
  await deleteList(google, store, 'L2');
  expect(store.snapshot().lastListId).toBeNull();
});

test('deleteList keeps another remembered Quick add list', async () => {
  await store.setMeta({ lastListId: 'L1' });
  await deleteList(google, store, 'L2');
  expect(store.snapshot().lastListId).toBe('L1');
});

test('a failed delete leaves the store as it was', async () => {
  const before = store.snapshot();
  await expect(deleteList(google, store, 'L1')).rejects.toBeInstanceOf(HttpError);
  const after = store.snapshot();
  expect(after.lists).toEqual(before.lists);
  expect(after.tasks).toEqual(before.tasks);
  expect(after.entries).toEqual(before.entries);
});
