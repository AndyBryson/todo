import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createAuth } from './auth';

const HOUR = 3600_000;
let requests = 0;

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  // Just enough of the page and of Google's script for a sign-in to complete.
  vi.stubGlobal('document', {
    createElement: () => ({}),
    head: { append: (el: { onload(): void }) => el.onload() },
  });
  requests = 0;
  vi.stubGlobal('google', {
    accounts: {
      oauth2: {
        initTokenClient: (cfg: {
          callback(r: { access_token: string; expires_in: number }): void;
        }) => ({
          requestAccessToken: () => {
            requests += 1;
            cfg.callback({ access_token: `token-${requests}`, expires_in: 3600 });
          },
        }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('a pass from an earlier visit is used after a restart without asking Google', async () => {
  await createAuth('client').signIn();
  expect(requests).toBe(1);

  const restarted = createAuth('client');
  expect(restarted.signedIn()).toBe(true);
  expect(await restarted.getToken()).toBe('token-1');
  expect(requests).toBe(1);
});

test('a saved pass that has run out is not used', async () => {
  vi.useFakeTimers({ now: new Date('2026-11-18T09:00:00Z') });
  await createAuth('client').signIn();
  vi.setSystemTime(Date.now() + HOUR + 1000);

  const restarted = createAuth('client');
  expect(restarted.signedIn()).toBe(false);
  expect(await restarted.getToken()).toBe('token-2');
});

test('an unreadable saved pass is ignored', async () => {
  localStorage.setItem('todo.token', '{not json');
  localStorage.setItem('todo.consented', '1');
  const auth = createAuth('client');
  expect(auth.signedIn()).toBe(false);
  expect(await auth.getToken()).toBe('token-1');
});
