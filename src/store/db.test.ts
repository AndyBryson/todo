import { expect, test } from 'vitest';
import { openStore } from './db';

test('a saved name with a broken time reads as no name', async () => {
  const name = `test-${crypto.randomUUID()}`;
  const store = await openStore(name);
  await store.setMeta({ accountName: { name: 'Home', updatedAt: 'not a time' } });
  expect((await openStore(name)).snapshot().accountName).toBeNull();
});

test('a saved name survives a restart', async () => {
  const name = `test-${crypto.randomUUID()}`;
  const store = await openStore(name);
  const saved = { name: 'Home', updatedAt: '2026-11-19T10:00:00.000Z' };
  await store.setMeta({ accountName: saved });
  expect((await openStore(name)).snapshot().accountName).toEqual(saved);
});
