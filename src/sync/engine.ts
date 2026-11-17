import { SYNC_INTERVAL_MS } from '../config';
import { AuthError, type GoogleApi, OfflineError } from '../google/api';
import type { Store } from '../store/db';
import { pull } from './pull';
import { replay } from './push';

export type SyncStatus =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'synced'; at: string }
  | { kind: 'offline' }
  | { kind: 'signin' }
  | { kind: 'error'; message: string };

export interface SyncEngine {
  syncNow(): Promise<void>;
  requestSync(): void;
  status(): SyncStatus;
  subscribe(fn: () => void): () => void;
  start(): void;
}

const DEBOUNCE_MS = 500;

export function createSyncEngine(
  google: GoogleApi,
  store: Store,
  clock: () => Date = () => new Date(),
): SyncEngine {
  let current: SyncStatus = { kind: 'idle' };
  const listeners = new Set<() => void>();
  let inflight: Promise<void> | null = null;
  let again = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  function setStatus(next: SyncStatus) {
    current = next;
    for (const fn of [...listeners]) fn();
  }

  async function cycle(): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setStatus({ kind: 'offline' });
      return;
    }
    setStatus({ kind: 'syncing' });
    try {
      const sent = await replay(google, store);
      if (sent === 'offline') return setStatus({ kind: 'offline' });
      if (sent === 'auth') return setStatus({ kind: 'signin' });
      if (sent === 'error') {
        return setStatus({ kind: 'error', message: 'Some changes could not be sent to Google.' });
      }
      const now = clock();
      if ((await pull(google, store, now)) === 'skipped') {
        again = true;
        return;
      }
      const at = now.toISOString();
      await store.setMeta({ lastSyncedAt: at });
      setStatus({ kind: 'synced', at });
    } catch (error) {
      if (error instanceof AuthError) setStatus({ kind: 'signin' });
      else if (error instanceof OfflineError) setStatus({ kind: 'offline' });
      else
        setStatus({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Sync failed',
        });
    }
  }

  // Replay must never run twice at once, so a call during a run only asks for another pass.
  async function loop(): Promise<void> {
    try {
      do {
        again = false;
        await cycle();
      } while (again);
    } finally {
      inflight = null;
    }
  }

  function syncNow(): Promise<void> {
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = loop();
    return inflight;
  }

  return {
    syncNow,
    requestSync() {
      clearTimeout(debounce);
      debounce = setTimeout(() => void syncNow(), DEBOUNCE_MS);
    },
    status: () => current,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    start() {
      void syncNow();
      if (typeof document === 'undefined' || typeof window === 'undefined') return;
      const visible = () => document.visibilityState === 'visible';
      document.addEventListener('visibilitychange', () => {
        if (visible()) void syncNow();
      });
      window.addEventListener('focus', () => void syncNow());
      window.addEventListener('online', () => void syncNow());
      setInterval(() => {
        if (visible()) void syncNow();
      }, SYNC_INTERVAL_MS);
    },
  };
}
