import { beforeEach, expect, test } from 'vitest';
import { task } from '../domain/test-fixtures';
import { AuthError, OfflineError } from '../google/api';
import { createFakeGoogle, type FakeGoogle } from '../google/fake';
import { openStore, type Store } from '../store/db';
import { addTask, editTask } from '../store/edits';
import { createSyncEngine, type SyncEngine } from './engine';

const NOW = new Date('2026-11-17T10:00:00Z');
const LISTS = [{ id: 'L1', title: 'One' }];
let store: Store;
let google: FakeGoogle;
let engine: SyncEngine;

beforeEach(async () => {
  store = await openStore(`test-${crypto.randomUUID()}`);
  const tasks = [task('x')];
  await store.replaceRemote(LISTS, tasks);
  google = createFakeGoogle({ lists: LISTS, tasks });
  engine = createSyncEngine(google, store, () => NOW);
});

test('a clean sync pulls and records when it finished', async () => {
  await engine.syncNow();
  expect(engine.status()).toEqual({ kind: 'synced', at: NOW.toISOString() });
  expect(store.snapshot().lastSyncedAt).toBe(NOW.toISOString());
  expect(store.snapshot().entries.x).toBeDefined();
});

test('expired sign-in shows as sign-in needed and keeps the queue', async () => {
  await editTask(store, 'x', { title: 'a' });
  google.failOn('getTask', new AuthError());
  await engine.syncNow();
  expect(engine.status()).toEqual({ kind: 'signin' });
  expect(await store.queue()).toHaveLength(1);
});

test('pull waits until the queue is empty so it cannot overwrite local edits', async () => {
  await editTask(store, 'x', { title: 'a' });
  google.failOn('getTask', new OfflineError());
  await engine.syncNow();
  expect(engine.status()).toEqual({ kind: 'offline' });
  expect(google.calls.some((c) => c.method === 'listTasks')).toBe(false);
  expect(store.snapshot().tasks.find((t) => t.id === 'x')?.title).toBe('a');
});

test('an offline pull shows as offline', async () => {
  google.failOn('listTaskLists', new OfflineError());
  await engine.syncNow();
  expect(engine.status()).toEqual({ kind: 'offline' });
});

test('an unexpected failure shows its message', async () => {
  google.failOn('listTaskLists', new Error('boom'));
  await engine.syncNow();
  expect(engine.status()).toEqual({ kind: 'error', message: 'boom' });
});

test('two syncs at once never replay concurrently', async () => {
  await addTask(store, { listId: 'L1', title: 'New', pinned: false }, NOW.toISOString());
  await Promise.all([engine.syncNow(), engine.syncNow()]);
  expect(google.calls.filter((c) => c.method === 'insertTask')).toHaveLength(1);
  expect(engine.status().kind).toBe('synced');
});

test('an edit made mid-pull is sent and pulled on the follow-up pass', async () => {
  google.onAfter('listTasks', () => {
    void editTask(store, 'x', { title: 'Mine' });
  });
  const realList = google.listTasks.bind(google);
  google.listTasks = async (...args) => {
    const result = await realList(...args);
    await new Promise((r) => setTimeout(r, 20));
    return result;
  };
  await engine.syncNow();
  expect(google.tasks.get('x')?.title).toBe('Mine');
  expect(await store.queue()).toEqual([]);
  expect(engine.status().kind).toBe('synced');
});
