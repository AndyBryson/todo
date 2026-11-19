import { beforeEach, expect, test } from 'vitest';
import { ACCOUNT_FILE, parseAccountFile, serialiseAccountFile } from '../domain/account-name';
import { createFakeGoogle, type FakeGoogle } from '../google/fake';
import { openStore, type Store } from '../store/db';
import { renameAccount } from '../store/edits';
import { syncAccountName } from './account-name';

const T1 = '2026-11-19T10:00:00.000Z';
const T2 = '2026-11-19T11:00:00.000Z';
let store: Store;
let google: FakeGoogle;

const remoteName = async () => parseAccountFile((await google.readAppFile(ACCOUNT_FILE)).raw);
const writes = () => google.calls.filter((c) => c.method === 'writeAppFile').length;

beforeEach(async () => {
  store = await openStore(`test-${crypto.randomUUID()}`);
  google = createFakeGoogle({});
});

test('a rename made offline is written on the next sync', async () => {
  await renameAccount(store, '  Work ', T1);
  await syncAccountName(google, store);
  expect(await remoteName()).toEqual({ name: 'Work', updatedAt: T1 });
});

test('a rename from another device arrives', async () => {
  const remote = { name: 'Home', updatedAt: T2 };
  google = createFakeGoogle({ files: { [ACCOUNT_FILE]: serialiseAccountFile(remote) } });
  await renameAccount(store, 'Work', T1);
  await syncAccountName(google, store);
  expect(store.snapshot().accountName).toEqual(remote);
  expect(writes()).toBe(0);
});

test('clearing the name syncs as an empty name', async () => {
  await renameAccount(store, 'Work', T1);
  await syncAccountName(google, store);
  await renameAccount(store, '   ', T2);
  await syncAccountName(google, store);
  expect(await remoteName()).toEqual({ name: '', updatedAt: T2 });
});

test('two devices settle on the later rename', async () => {
  const other = await openStore(`test-${crypto.randomUUID()}`);
  await renameAccount(store, 'First', T1);
  await renameAccount(other, 'Second', T2);
  for (let round = 0; round < 2; round++) {
    await syncAccountName(google, store);
    await syncAccountName(google, other);
  }
  expect(store.snapshot().accountName).toEqual({ name: 'Second', updatedAt: T2 });
  expect(other.snapshot().accountName).toEqual({ name: 'Second', updatedAt: T2 });
  const before = writes();
  await syncAccountName(google, store);
  await syncAccountName(google, other);
  expect(writes()).toBe(before);
});

test('a damaged remote file is replaced by the local name', async () => {
  google = createFakeGoogle({ files: { [ACCOUNT_FILE]: '{' } });
  await renameAccount(store, 'Work', T1);
  await syncAccountName(google, store);
  expect(await remoteName()).toEqual({ name: 'Work', updatedAt: T1 });
});

test('with no name on either side nothing is written', async () => {
  await syncAccountName(google, store);
  expect(writes()).toBe(0);
});
