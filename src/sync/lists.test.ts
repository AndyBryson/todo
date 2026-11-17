import { beforeEach, expect, test } from 'vitest';
import { entry, task } from '../domain/test-fixtures';
import { HttpError } from '../google/api';
import { createFakeGoogle, type FakeGoogle } from '../google/fake';
import { openStore, type Store } from '../store/db';
import { moveToList } from '../store/edits';
import { BlankNameError, createList, deleteList, PendingMoveError, renameList } from './lists';
import { pull } from './pull';

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
      { kind: 'patch', listId: 'L2', taskId: 'p', set: { title: 'P' }, base: { title: 'p' } },
    ],
  });
  await deleteList(google, store, 'L2');
  expect(store.snapshot().queued.map((q) => q.op.listId)).toEqual(['L1']);
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

test('a list with a move out of it still waiting is not deleted', async () => {
  // Google still has the moved task in the list, so deleting now would delete it too.
  await moveToList(store, 'q', 'L1');
  const before = store.snapshot();
  await expect(deleteList(google, store, 'L2')).rejects.toBeInstanceOf(PendingMoveError);
  expect(google.calls.filter((c) => c.method === 'deleteTaskList')).toEqual([]);
  expect(store.snapshot().tasks).toEqual(before.tasks);
  expect(store.snapshot().queued).toEqual(before.queued);
});

test('a list with a move into it still waiting is not deleted', async () => {
  await moveToList(store, 'a', 'L2');
  await expect(deleteList(google, store, 'L2')).rejects.toBeInstanceOf(PendingMoveError);
  expect(google.lists.map((l) => l.id)).toEqual(['L1', 'L2']);
});

test('a pull that fetched before a list change does not undo it', async () => {
  google.onAfter('listTaskLists', () => {
    void createList(google, store, 'Garden');
  });
  // Lets the create land between the pull's fetch and its write.
  google.onAfter('listTasks', () => {});
  const result = await pull(google, store, new Date('2026-11-17T10:00:00Z'));
  await new Promise((r) => setTimeout(r, 0));
  expect(result).toBe('skipped');
  expect(store.snapshot().lists.map((l) => l.title)).toContain('Garden');
});
