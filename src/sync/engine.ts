import { SYNC_INTERVAL_MS } from '../config';
import { AuthError, type GoogleApi, OfflineError } from '../google/api';
import type { Store } from '../store/db';
import { syncAccountName } from './account-name';
import { pull } from './pull';
import { type ReplayHooks, replay } from './push';

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
  stop(): void;
}

const DEBOUNCE_MS = 500;

export function createSyncEngine(
  google: GoogleApi,
  store: Store,
  clock: () => Date = () => new Date(),
  hooks?: ReplayHooks,
): SyncEngine {
  let current: SyncStatus = { kind: 'idle' };
  const listeners = new Set<() => void>();
  let inflight: Promise<void> | null = null;
  let again = false;
  let stopStart: (() => void) | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  function setStatus(next: SyncStatus) {
    current = next;
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        // One broken subscriber must not abort the sync pass.
      }
    }
  }

  async function cycle(): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setStatus({ kind: 'offline' });
      return;
    }
    setStatus({ kind: 'syncing' });
    try {
      const sent = await replay(google, store, hooks);
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
      await syncAccountName(google, store);
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

  const engine: SyncEngine = {
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
      if (stopStart) return;
      void syncNow();
      if (typeof document === 'undefined' || typeof window === 'undefined') {
        stopStart = () => undefined;
        return;
      }
      const visible = () => document.visibilityState === 'visible';
      // Focus and visibility usually fire together, so both go through the debounce.
      const onVisibility = () => {
        if (visible()) engine.requestSync();
      };
      const onWake = () => engine.requestSync();
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('focus', onWake);
      window.addEventListener('online', onWake);
      const timer = setInterval(() => {
        if (visible()) void syncNow();
      }, SYNC_INTERVAL_MS);
      stopStart = () => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('focus', onWake);
        window.removeEventListener('online', onWake);
        clearInterval(timer);
      };
    },
    stop() {
      clearTimeout(debounce);
      stopStart?.();
      stopStart = null;
    },
  };
  return engine;
}
