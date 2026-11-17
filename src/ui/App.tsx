import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Auth } from '../google/auth';
import type { Store } from '../store/db';
import type { SyncEngine } from '../sync/engine';
import { Board } from './Board';
import { Header } from './Header';
import { useSnapshot, useSyncStatus } from './hooks';
import { ListFilter } from './ListFilter';

const FILTER_KEY = 'todo.filter';

function loadFilter(): Set<string> | null {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(ids) && ids.length > 0 ? new Set(ids.map(String)) : null;
  } catch {
    return null;
  }
}

function saveFilter(filter: Set<string> | null) {
  try {
    if (filter) localStorage.setItem(FILTER_KEY, JSON.stringify([...filter]));
    else localStorage.removeItem(FILTER_KEY);
  } catch {
    // Storage can be blocked; the filter then lasts for this visit only.
  }
}

const readRoute = () => (location.hash === '#/today' ? 'today' : 'board');

interface Props {
  store: Store;
  engine: SyncEngine;
  auth: Auth;
}

export function App({ store, engine, auth }: Props) {
  const snapshot = useSnapshot(store);
  const status = useSyncStatus(engine);
  const [route, setRoute] = useState(readRoute);
  const [filter, setFilter] = useState(loadFilter);
  const [actionError, setActionError] = useState<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => () => clearTimeout(errorTimer.current), []);

  const showError = useCallback((e: unknown) => {
    setActionError(e instanceof Error ? e.message : String(e));
    clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setActionError(null), 6000);
  }, []);

  // The one place an edit is paired with a sync request.
  const act = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await fn();
        clearTimeout(errorTimer.current);
        setActionError(null);
        engine.requestSync();
      } catch (e) {
        showError(e);
      }
    },
    [engine, showError],
  );

  // Lists can disappear after a sync; a stale selection must not hide every card.
  const effectiveFilter = useMemo(() => {
    if (!filter) return null;
    const ids = new Set(snapshot.lists.map((l) => l.id));
    const kept = new Set([...filter].filter((id) => ids.has(id)));
    return kept.size > 0 ? kept : null;
  }, [filter, snapshot.lists]);

  function changeFilter(next: Set<string> | null) {
    setFilter(next);
    saveFilter(next);
  }

  async function signIn() {
    try {
      await auth.signIn();
      await engine.syncNow();
    } catch (e) {
      showError(e);
    }
  }

  return (
    <>
      <Header
        status={status}
        queueLength={snapshot.queueLength}
        notices={snapshot.notices}
        actionError={actionError}
        route={route}
        onSignIn={() => void signIn()}
        onDismiss={(id) => void store.dismissNotice(id)}
      />
      <ListFilter lists={snapshot.lists} selected={effectiveFilter} onChange={changeFilter} />
      <main class="main">
        {route === 'today' ? (
          <p class="placeholder">Today view arrives in a later task.</p>
        ) : (
          <Board store={store} snapshot={snapshot} filter={effectiveFilter} act={act} />
        )}
      </main>
    </>
  );
}
