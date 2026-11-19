import { afterEach, expect, test } from 'vitest';
import { task } from '../domain/test-fixtures';
import { AuthError, HttpError } from '../google/api';
import { createFakeGoogle } from '../google/fake';
import { openStore } from '../store/db';
import { editTask } from '../store/edits';
import { loadRegistry, tokenKey } from './registry';
import type { AccountSet } from './set';
import { harness, memoryStorage, record } from './test-fixtures';

const LISTS = [{ id: 'L1', title: 'Mine' }];
let running: AccountSet | undefined;

afterEach(() => {
  for (const a of running?.all() ?? []) a.engine.stop();
  running = undefined;
});

async function seedStore(name: string, defaultListId: string | null = null) {
  const store = await openStore(name);
  await store.commit({
    replaceRemote: { lists: LISTS, tasks: [task('x')] },
    ...(defaultListId ? { meta: { defaultListId } } : {}),
  });
  await editTask(store, 'x', { title: 'Renamed offline' });
  return store;
}

test('the first start keeps the old database and its queue', async () => {
  const prefix = `test-${crypto.randomUUID()}`;
  await seedStore(`${prefix}-todo`);
  const storage = memoryStorage({ 'todo.token': '{"token":"t","expiresAt":9}' });
  const google = createFakeGoogle({ lists: LISTS, tasks: [task('x')] });

  const { set } = await harness({ storage, prefix, googles: {}, next: google });
  running = set;
  const [first] = set.all();
  expect(set.all()).toHaveLength(1);
  expect(first?.record.db).toBe('todo');
  expect(storage.data.get(tokenKey(first?.record.id ?? ''))).toBe('{"token":"t","expiresAt":9}');
  expect(first?.store.snapshot().queueLength).toBe(1);

  await first?.engine.syncNow();
  expect(google.tasks.get('x')?.title).toBe('Renamed offline');
  expect(first?.store.snapshot().queueLength).toBe(0);
  // The migrated record learns who it belongs to on its first contact with Google.
  expect(loadRegistry(storage)[0]).toMatchObject({ email: 'me@example.com', label: 'Me' });
});

test('a renewal that returns another account is refused', async () => {
  const prefix = `test-${crypto.randomUUID()}`;
  await seedStore(`${prefix}-todo-a`);
  const google = createFakeGoogle({
    lists: LISTS,
    tasks: [task('x')],
    account: { email: 'other@example.com', name: 'Other' },
  });

  const { set, auths } = await harness({
    records: [record('a', 'me@example.com')],
    prefix,
    googles: { a: google },
  });
  running = set;
  const a = set.get('a');
  await a?.engine.syncNow();

  expect(auths.get('a')?.forgets).toBe(1);
  expect(a?.store.snapshot().notices.map((n) => n.text)).toEqual([
    'Signed in as other@example.com, not me@example.com. Sign in again.',
  ]);
  expect(google.calls.map((c) => c.method)).toEqual(['getAccount']);
  expect(google.tasks.get('x')?.title).toBe('x');
  expect(a?.store.snapshot().queueLength).toBe(1);
  expect(a?.engine.status()).toEqual({ kind: 'signin' });
  expect(a?.record.email).toBe('me@example.com');
});

test('adding an account already signed in is refused', async () => {
  const { set, auths, storage } = await harness({
    records: [record('a', 'me@example.com')],
    googles: { a: createFakeGoogle({ lists: LISTS }) },
    next: createFakeGoogle({ account: { email: 'me@example.com', name: 'Me again' } }),
  });
  running = set;

  expect(await set.add()).toBe('duplicate');
  expect(set.all().map((a) => a.record.id)).toEqual(['a']);
  expect(loadRegistry(storage).map((r) => r.id)).toEqual(['a']);
  const added = [...auths].find(([id]) => id !== 'a')?.[1];
  expect(added?.forgets).toBe(1);
});

test('adding a new account saves who it is and starts it', async () => {
  const shared = createFakeGoogle({
    lists: [{ id: 'T1', title: 'Theirs' }],
    account: { email: 'shared@example.com', name: '' },
  });
  const { set, storage } = await harness({
    records: [record('a', 'me@example.com')],
    googles: { a: createFakeGoogle({ lists: LISTS }) },
    next: shared,
  });
  running = set;

  expect(await set.add()).toBe('added');
  const added = set.all()[1];
  expect(added?.record).toMatchObject({
    email: 'shared@example.com',
    label: 'shared',
    db: `todo-${added?.record.id}`,
    signedOut: false,
  });
  expect(loadRegistry(storage)).toHaveLength(2);
  await added?.engine.syncNow();
  expect(added?.store.snapshot().lists.map((l) => l.id)).toEqual(['T1']);
});

test('signing out keeps the store and its queue but leaves the active set', async () => {
  const prefix = `test-${crypto.randomUUID()}`;
  await seedStore(`${prefix}-todo-a`);
  const { set, auths, storage } = await harness({
    records: [record('a', 'me@example.com')],
    prefix,
    googles: { a: createFakeGoogle({ lists: LISTS, tasks: [task('x')] }) },
  });
  running = set;
  await set.signOut('a');
  expect(set.active()).toEqual([]);
  expect(auths.get('a')?.forgets).toBe(1);
  expect(loadRegistry(storage)[0]?.signedOut).toBe(true);
  expect(set.get('a')?.store.snapshot().queueLength).toBe(1);
});

test('a token whose account cannot be confirmed is never used', async () => {
  const prefix = `test-${crypto.randomUUID()}`;
  await seedStore(`${prefix}-todo-a`);
  const google = createFakeGoogle({ lists: LISTS, tasks: [task('x')] });
  google.failOn('getAccount', new HttpError(403, 'Forbidden'), { times: 2 });

  const { set, auths } = await harness({
    records: [record('a', 'me@example.com')],
    prefix,
    googles: { a: google },
  });
  running = set;
  const a = set.get('a');
  await a?.engine.syncNow();

  expect(google.calls.every((c) => c.method === 'getAccount')).toBe(true);
  expect(google.tasks.get('x')?.title).toBe('x');
  expect(a?.store.snapshot().queueLength).toBe(1);
  expect(a?.engine.status()).toEqual({
    kind: 'error',
    message: "Couldn't confirm which Google account this is.",
  });
  expect(auths.get('a')?.forgets).toBe(0);

  // Checked again on the next sync, which then goes ahead.
  await a?.engine.syncNow();
  expect(google.tasks.get('x')?.title).toBe('Renamed offline');
  expect(a?.engine.status().kind).toBe('synced');
});

test('a renewal to another account mid-session sends nothing with the new token', async () => {
  const google = createFakeGoogle({ lists: LISTS, tasks: [task('x')] });
  const { set, auths, identities, sent } = await harness({
    records: [record('a', 'me@example.com')],
    googles: { a: google },
  });
  running = set;
  const a = set.get('a');
  await a?.engine.syncNow();
  expect(a?.engine.status().kind).toBe('synced');

  // A quiet renewal that comes back with someone else's token.
  await auths.get('a')?.signIn();
  identities.set('token-2', { email: 'other@example.com', name: 'Other' });
  await expect(a?.google.listTaskLists()).rejects.toBeInstanceOf(AuthError);

  expect(sent.filter((s) => s.token === 'token-2').map((s) => s.method)).toEqual(['getAccount']);
  expect(auths.get('a')?.forgets).toBe(1);
  expect(a?.store.snapshot().notices.map((n) => n.text)).toEqual([
    'Signed in as other@example.com, not me@example.com. Sign in again.',
  ]);
});

test('a record still learning its email cannot become a second copy of an account', async () => {
  const shared = createFakeGoogle({
    lists: [{ id: 'T1', title: 'Theirs' }],
    account: { email: 'shared@example.com', name: 'Shared' },
  });
  const { set, auths, storage } = await harness({
    records: [record('a', null, 'todo'), record('b', 'shared@example.com')],
    googles: { a: shared, b: shared },
  });
  running = set;
  const a = set.get('a');
  await a?.engine.syncNow();

  expect(auths.get('a')?.forgets).toBe(1);
  expect(a?.store.snapshot().notices.map((n) => n.text)).toEqual([
    'This Google account is already signed in.',
  ]);
  expect(a?.record.email).toBeNull();
  expect(loadRegistry(storage)[0]?.email).toBeNull();
  expect(a?.engine.status()).toEqual({ kind: 'signin' });
  expect(a?.store.snapshot().lists).toEqual([]);
});

test("an upgraded device refuses a Google account that doesn't own its saved tasks", async () => {
  const prefix = `test-${crypto.randomUUID()}`;
  await seedStore(`${prefix}-todo`, 'me-default');
  const household = createFakeGoogle({
    lists: [{ id: 'house-default', title: 'My Tasks' }, ...LISTS],
    tasks: [task('x')],
    account: { email: 'house@example.com', name: 'House' },
  });

  const { set, auths, storage } = await harness({
    records: [record('a', null, 'todo')],
    prefix,
    googles: { a: household },
  });
  running = set;
  const a = set.get('a');
  await a?.engine.syncNow();

  expect(household.calls.map((c) => c.method)).toEqual(['getAccount', 'getDefaultListId']);
  expect(household.tasks.get('x')?.title).toBe('x');
  expect(a?.store.snapshot().queueLength).toBe(1);
  expect(a?.record.email).toBeNull();
  expect(loadRegistry(storage)[0]?.email).toBeNull();
  expect(auths.get('a')?.forgets).toBe(1);
  expect(a?.store.snapshot().notices.map((n) => n.text)).toEqual([
    "This device's saved tasks belong to a different Google account. Sign in with that one.",
  ]);
  expect(a?.engine.status()).toEqual({ kind: 'signin' });
});

test('an upgraded device learns the email when the default lists match', async () => {
  const prefix = `test-${crypto.randomUUID()}`;
  await seedStore(`${prefix}-todo`, 'me-default');
  const google = createFakeGoogle({
    lists: [{ id: 'me-default', title: 'My Tasks' }, ...LISTS],
    tasks: [task('x')],
  });

  const { set, storage } = await harness({
    records: [record('a', null, 'todo')],
    prefix,
    googles: { a: google },
  });
  running = set;
  const a = set.get('a');
  await a?.engine.syncNow();

  expect(loadRegistry(storage)[0]).toMatchObject({ email: 'me@example.com', label: 'Me' });
  expect(google.tasks.get('x')?.title).toBe('Renamed offline');
  expect(a?.store.snapshot().notices).toEqual([]);
});

test('signing in to an account with no email yet opens the account chooser', async () => {
  const { set, auths } = await harness({
    records: [record('a', null, 'todo'), record('b', 'shared@example.com')],
    googles: {
      a: createFakeGoogle({ lists: LISTS }),
      b: createFakeGoogle({ account: { email: 'shared@example.com', name: 'Shared' } }),
    },
  });
  running = set;
  await set.signIn('a');
  await set.signIn('b');
  expect(auths.get('a')?.signIns).toEqual([{ chooseAccount: true }]);
  expect(auths.get('b')?.signIns).toEqual([{ chooseAccount: false }]);
});
