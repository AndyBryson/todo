import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Auth } from '../google/auth';
import type { Store } from '../store/db';
import type { SyncEngine } from '../sync/engine';
import { Board } from './Board';
import { CardDetail, closeDetail, type DetailView } from './CardDetail';
import { Header } from './Header';
import { useSnapshot, useSyncStatus } from './hooks';
import { ListFilter } from './ListFilter';
import { Today } from './Today';

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

function readRoute(): { view: DetailView; taskId: string | null } {
  const [, view, kind, id] = location.hash.split('/');
  return {
    view: view === 'today' ? 'today' : 'board',
    taskId: kind === 'task' && id ? decodeURIComponent(id) : null,
  };
}

interface Props {
  store: Store;
  engine: SyncEngine;
  auth: Auth;
}

export function App({ store, engine, auth }: Props) {
  const snapshot = useSnapshot(store);
  const status = useSyncStatus(engine);
  const [{ view, taskId }, setRoute] = useState(readRoute);
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
    async (fn: () => Promise<unknown>): Promise<boolean> => {
      try {
        await fn();
        clearTimeout(errorTimer.current);
        setActionError(null);
      } catch (e) {
        showError(e);
        return false;
      }
      // Apart from the edit, so a failing sync request cannot make a saved edit look failed.
      try {
        engine.requestSync();
      } catch (e) {
        showError(e);
      }
      return true;
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
        route={view}
        onSignIn={() => void signIn()}
        onDismiss={(id) => void store.dismissNotice(id)}
      />
      <ListFilter lists={snapshot.lists} selected={effectiveFilter} onChange={changeFilter} />
      <main class="main">
        {view === 'today' ? (
          <Today store={store} snapshot={snapshot} act={act} />
        ) : (
          <Board store={store} snapshot={snapshot} filter={effectiveFilter} act={act} />
        )}
      </main>
      {taskId && (
        <CardDetail
          key={taskId}
          error={actionError}
          taskId={taskId}
          view={view}
          store={store}
          snapshot={snapshot}
          act={act}
          onClose={() => closeDetail(view)}
        />
      )}
    </>
  );
}
