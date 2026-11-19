import { AuthError, type GoogleApi } from '../google/api';
import type { Auth } from '../google/auth';
import type { FakeGoogle } from '../google/fake';
import { openStore } from '../store/db';
import type { AccountRecord, KeyValue } from './registry';
import { type AccountSet, createAccountSet } from './set';

export function memoryStorage(
  initial: Record<string, string> = {},
): KeyValue & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

export interface FakeAuth extends Auth {
  forgets: number;
}

export function fakeAuth(): FakeAuth {
  let token: string | null = 'token-1';
  let issued = 1;
  const listeners = new Set<() => void>();
  const auth: FakeAuth = {
    forgets: 0,
    async getToken() {
      if (token === null) throw new AuthError('Sign in needed');
      return token;
    },
    async signIn() {
      issued += 1;
      token = `token-${issued}`;
      for (const fn of listeners) fn();
    },
    forget() {
      auth.forgets += 1;
      token = null;
      for (const fn of listeners) fn();
    },
    signedIn: () => token !== null,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return auth;
}

export const record = (id: string, email: string | null, db = `todo-${id}`): AccountRecord => ({
  id,
  email,
  label: null,
  db,
  signedOut: false,
});

// Each test gets its own database names, so runs never see each other's data.
export async function harness(opts: {
  records?: AccountRecord[];
  storage?: ReturnType<typeof memoryStorage>;
  googles: Record<string, FakeGoogle>;
  // For an ID the test didn't name, as add() makes a fresh one.
  next?: FakeGoogle;
  prefix?: string;
}) {
  const storage = opts.storage ?? memoryStorage();
  if (opts.records) storage.setItem('todo.accounts', JSON.stringify(opts.records));
  const prefix = opts.prefix ?? `test-${crypto.randomUUID()}`;
  const auths = new Map<string, FakeAuth>();
  // Who a token belongs to, when a test wants it to differ from the fake's account.
  const identities = new Map<string, { email: string; name: string }>();
  const sent: { method: string; token: string }[] = [];
  const set: AccountSet = await createAccountSet({
    storage,
    openStore: (db) => openStore(`${prefix}-${db}`),
    connect(id) {
      const auth = auths.get(id) ?? fakeAuth();
      auths.set(id, auth);
      const fake = opts.googles[id] ?? opts.next;
      if (!fake) throw new Error(`No fake Google for ${id}`);
      return { auth, google: (getToken) => tokenGated(fake, getToken, identities, sent) };
    },
    clock: () => new Date('2026-11-19T10:00:00Z'),
  });
  return { set, storage, auths, prefix, identities, sent };
}

export async function syncAll(set: AccountSet): Promise<void> {
  for (const a of set.active()) await a.engine.syncNow();
}

// Like the HTTP client, asks for a token on every request and says who it is from that token.
function tokenGated(
  fake: FakeGoogle,
  getToken: () => Promise<string>,
  identities: Map<string, { email: string; name: string }>,
  sent: { method: string; token: string }[],
): GoogleApi {
  return new Proxy(fake, {
    get(target, prop, receiver) {
      const member = Reflect.get(target, prop, receiver);
      if (typeof member !== 'function') return member;
      return async (...args: unknown[]) => {
        const token = await getToken();
        sent.push({ method: String(prop), token });
        const who = prop === 'getAccount' ? identities.get(token) : undefined;
        return who ? { ...who } : member.apply(target, args);
      };
    },
  });
}
