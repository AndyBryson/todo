import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AuthError } from './api';
import { createAuth } from './auth';

const opts = { id: 'a', loginHint: () => null };

const HOUR = 3600_000;
let requests = 0;
let overrides: Record<string, string>[] = [];

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
  overrides = [];
  vi.stubGlobal('google', {
    accounts: {
      oauth2: {
        initTokenClient: (cfg: {
          callback(r: { access_token: string; expires_in: number }): void;
        }) => ({
          requestAccessToken: (o: Record<string, string>) => {
            requests += 1;
            overrides.push(o);
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
  await createAuth('client', opts).signIn();
  expect(requests).toBe(1);

  const restarted = createAuth('client', opts);
  expect(restarted.signedIn()).toBe(true);
  expect(await restarted.getToken()).toBe('token-1');
  expect(requests).toBe(1);
});

test('a saved pass that has run out is not used', async () => {
  vi.useFakeTimers({ now: new Date('2026-11-18T09:00:00Z') });
  await createAuth('client', opts).signIn();
  vi.setSystemTime(Date.now() + HOUR + 1000);

  const restarted = createAuth('client', opts);
  expect(restarted.signedIn()).toBe(false);
  expect(await restarted.getToken()).toBe('token-2');
});

test('an unreadable saved pass is ignored', async () => {
  localStorage.setItem('todo.token.a', '{not json');
  localStorage.setItem('todo.consented.a', '1');
  const auth = createAuth('client', opts);
  expect(auth.signedIn()).toBe(false);
  expect(await auth.getToken()).toBe('token-1');
});

test("keeps each account's token apart", async () => {
  const a = createAuth('client', { id: 'a', loginHint: () => null });
  const b = createAuth('client', { id: 'b', loginHint: () => null });
  await a.signIn();
  expect(localStorage.getItem('todo.token.a')).not.toBeNull();
  expect(localStorage.getItem('todo.token.b')).toBeNull();
  expect(b.signedIn()).toBe(false);
});

test("asks Google for the account's email", async () => {
  await createAuth('client', { id: 'a', loginHint: () => 'x@example.com' }).signIn();
  expect(overrides[0]).toEqual({ login_hint: 'x@example.com', prompt: '' });
});

test('the account chooser is shown when adding an account', async () => {
  await createAuth('client', opts).signIn({ chooseAccount: true });
  expect(overrides[0]?.prompt).toBe('select_account');
});

test('forget signs out and stops quiet renewal', async () => {
  const auth = createAuth('client', opts);
  await auth.signIn();
  const seen = vi.fn();
  auth.subscribe(seen);
  auth.forget();
  expect(auth.signedIn()).toBe(false);
  expect(localStorage.getItem('todo.token.a')).toBeNull();
  expect(localStorage.getItem('todo.consented.a')).toBeNull();
  expect(seen).toHaveBeenCalled();
  const before = requests;
  await expect(auth.getToken()).rejects.toBeInstanceOf(AuthError);
  expect(requests).toBe(before);
});
