import { AccountUnconfirmedError, AuthError, type GoogleApi, OfflineError } from '../google/api';
import type { Auth } from '../google/auth';
import type { Op, Store } from '../store/db';
import { createSyncEngine, type SyncEngine } from '../sync/engine';
import type { ReplayHooks } from '../sync/push';
import {
  type AccountRecord,
  type KeyValue,
  loadRegistry,
  newAccountId,
  saveRegistry,
} from './registry';

export interface Account {
  record: AccountRecord;
  store: Store;
  auth: Auth;
  google: GoogleApi;
  engine: SyncEngine;
}

export interface AccountDeps {
  storage: KeyValue;
  openStore(db: string): Promise<Store>;
  connect(id: string, loginHint: () => string | null): { auth: Auth; google: GoogleApi };
  clock?: () => Date;
}

export interface AccountSet {
  all(): Account[];
  // Accounts not signed out, whether or not their token is fresh: their cards show.
  active(): Account[];
  get(id: string): Account | undefined;
  add(): Promise<'added' | 'duplicate'>;
  signIn(id: string): Promise<void>;
  signOut(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  subscribe(fn: () => void): () => void;
}

type Handoff = Extract<Op, { kind: 'handoff' }>;

const labelFor = (who: { email: string; name: string }) =>
  who.name || (who.email.split('@')[0] as string);
const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function createAccountSet(deps: AccountDeps): Promise<AccountSet> {
  let records = loadRegistry(deps.storage);
  if (records.length === 0) {
    // Every stored record was unreadable, so this is a fresh start.
    records = [{ id: newAccountId(), db: 'todo', email: null, label: null, signedOut: false }];
    saveRegistry(deps.storage, records);
  }

  let accounts: Account[] = [];
  let activeCache: Account[] | null = null;
  const listeners = new Set<() => void>();

  function notify() {
    activeCache = null;
    for (const fn of [...listeners]) fn();
  }

  function setAccounts(next: Account[]) {
    accounts = next;
    saveRegistry(
      deps.storage,
      next.map((a) => a.record),
    );
    notify();
  }

  function update(account: Account, patch: Partial<AccountRecord>) {
    account.record = { ...account.record, ...patch };
    setAccounts([...accounts]);
  }

  const byId = (id: string) => accounts.find((a) => a.record.id === id);

  const hooks: ReplayHooks = {
    // Push keeps a handoff at the head of the queue until this resolves, so it must
    // only ever fail for a moment, never for good.
    async handoff(op: Handoff) {
      const source = byId(op.source.accountId);
      if (!source) return;
      const taskId = op.source.taskId;
      // A restart between this commit and the handoff's dequeue runs it again.
      await source.store.commit((s) =>
        s.queued.some((q) => q.op.kind === 'transferDelete' && q.op.taskId === taskId)
          ? {}
          : {
              enqueue: [
                {
                  kind: 'transferDelete',
                  listId: op.source.listId,
                  taskId,
                  title: op.source.title,
                  fingerprint: op.fingerprint,
                },
              ],
            },
      );
      if (!source.record.signedOut) source.engine.requestSync();
    },
  };

  // An original stays hidden only while some queue still carries its move forward.
  async function sweepTransfers(): Promise<void> {
    await Promise.all(
      accounts.map((source) =>
        source.store.commit((s) => {
          const keep: Record<string, string> = {};
          for (const [taskId, targetId] of Object.entries(s.hidden)) {
            const target = byId(targetId);
            const deleting = s.queued.some(
              (q) => q.op.kind === 'transferDelete' && q.op.taskId === taskId,
            );
            const copying = target?.store
              .snapshot()
              .queued.some(
                (q) =>
                  q.op.kind === 'handoff' &&
                  q.op.source.taskId === taskId &&
                  q.op.source.accountId === source.record.id,
              );
            if (deleting || copying) keep[taskId] = targetId;
          }
          return Object.keys(keep).length === Object.keys(s.hidden).length
            ? {}
            : { meta: { hidden: keep } };
        }),
      ),
    );
  }

  function sweepSoon() {
    sweepTransfers().catch(() => {
      // A store closed mid-sweep, by a remove: the next sync sweeps again.
    });
  }

  // Every call to Google first checks who the current token belongs to, so one
  // account's queue is never sent with another account's token.
  function guard(account: Account, raw: GoogleApi): { google: GoogleApi; verify(): Promise<void> } {
    let verified: string | null = null;
    let checking: { token: string; done: Promise<void> } | null = null;

    async function check(token: string): Promise<void> {
      let who: { email: string; name: string };
      try {
        who = await raw.getAccount();
      } catch (error) {
        if (error instanceof AuthError || error instanceof OfflineError) throw error;
        // Unconfirmed is treated as possibly wrong: the check runs again next sync.
        throw new AccountUnconfirmedError("Couldn't confirm which Google account this is.");
      }
      const expected = account.record.email;
      if (expected === null) {
        update(account, { email: who.email, label: labelFor(who) });
      } else if (!sameEmail(expected, who.email)) {
        account.auth.forget();
        await account.store.commit({
          notices: [`Signed in as ${who.email}, not ${expected}. Sign in again.`],
        });
        throw new AuthError('Signed in to another account');
      }
      verified = token;
    }

    async function verify(): Promise<void> {
      const token = await account.auth.getToken();
      if (token === verified) return;
      if (checking?.token !== token) {
        const done = check(token).finally(() => {
          if (checking?.done === done) checking = null;
        });
        checking = { token, done };
      }
      await checking.done;
    }

    const google = new Proxy(raw, {
      get(target, prop, receiver) {
        const member = Reflect.get(target, prop, receiver);
        if (typeof member !== 'function' || prop === 'getAccount') return member;
        return async (...args: unknown[]) => {
          await verify();
          return member.apply(target, args);
        };
      },
    });
    return { google, verify };
  }

  const verifiers = new WeakMap<Account, () => Promise<void>>();

  async function verify(account: Account): Promise<void> {
    try {
      await verifiers.get(account)?.();
    } catch {
      // Offline or signed out: checked again before the next call to Google.
    }
  }

  function build(
    record: AccountRecord,
    store: Store,
    conn: { auth: Auth; google: GoogleApi },
  ): Account {
    const account = { record, store, auth: conn.auth } as Account;
    const guarded = guard(account, conn.google);
    account.google = guarded.google;
    verifiers.set(account, guarded.verify);
    account.engine = createSyncEngine(account.google, store, deps.clock, hooks);
    store.subscribe(notify);
    account.engine.subscribe(() => {
      notify();
      if (account.engine.status().kind === 'synced') sweepSoon();
    });
    return account;
  }

  function hintFor(id: string) {
    return () => byId(id)?.record.email ?? null;
  }

  for (const record of records) {
    const store = await deps.openStore(record.db);
    accounts.push(build(record, store, deps.connect(record.id, hintFor(record.id))));
  }
  for (const a of accounts) if (!a.record.signedOut) a.engine.start();
  sweepSoon();

  function stopAndForget(account: Account) {
    account.engine.stop();
    account.auth.forget();
  }

  return {
    all: () => accounts,
    active() {
      activeCache ??= accounts.filter((a) => !a.record.signedOut);
      return activeCache;
    },
    get: byId,

    async add() {
      const id = newAccountId();
      const conn = deps.connect(id, hintFor(id));
      let who: { email: string; name: string };
      try {
        await conn.auth.signIn({ chooseAccount: true });
        who = await conn.google.getAccount();
      } catch (error) {
        // No record is saved, so a token kept now would never be found again.
        conn.auth.forget();
        throw error;
      }
      if (accounts.some((a) => a.record.email !== null && sameEmail(a.record.email, who.email))) {
        conn.auth.forget();
        return 'duplicate';
      }
      const record: AccountRecord = {
        id,
        email: who.email,
        label: labelFor(who),
        db: `todo-${id}`,
        signedOut: false,
      };
      const account = build(record, await deps.openStore(record.db), conn);
      setAccounts([...accounts, account]);
      account.engine.start();
      return 'added';
    },

    async signIn(id) {
      const account = byId(id);
      if (!account) return;
      await account.auth.signIn();
      if (account.record.signedOut) update(account, { signedOut: false });
      await verify(account);
      account.engine.start();
      void account.engine.syncNow();
    },

    async signOut(id) {
      const account = byId(id);
      if (!account) return;
      stopAndForget(account);
      update(account, { signedOut: true });
    },

    async remove(id) {
      const account = byId(id);
      if (!account) return;
      stopAndForget(account);
      setAccounts(accounts.filter((a) => a !== account));
      await account.store.destroy();
      await sweepTransfers();
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
