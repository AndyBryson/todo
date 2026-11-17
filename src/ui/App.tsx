import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { activeFilterCount, type BoardFilters, DEFAULT_FILTERS } from '../domain/filters';
import { PRIORITIES, type Priority } from '../domain/types';
import { type GoogleApi, OfflineError } from '../google/api';
import type { Auth } from '../google/auth';
import type { Store } from '../store/db';
import { addTask } from '../store/edits';
import type { SyncEngine } from '../sync/engine';
import { createList, deleteList, PendingMoveError, renameList } from '../sync/lists';
import { Board } from './Board';
import { CardDetail, closeDetail, type DetailView } from './CardDetail';
import { Header } from './Header';
import { useIsPhone, useSnapshot, useSyncStatus } from './hooks';
import { PhoneNav } from './PhoneNav';
import { Sidebar, SidebarDrawer } from './Sidebar';
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

const PRIORITIES_KEY = 'todo.priorities';
const PLANNED_KEY = 'todo.planned';
const SIDEBAR_KEY = 'todo.sidebar';

function loadPriorities(): ReadonlySet<Priority> {
  try {
    const raw = localStorage.getItem(PRIORITIES_KEY);
    const levels: unknown = raw ? JSON.parse(raw) : null;
    // An empty array is a real choice (nothing shown); only a missing or malformed value falls back.
    if (!Array.isArray(levels)) return DEFAULT_FILTERS.priorities;
    const valid = PRIORITIES.filter((p) => levels.includes(p));
    // A non-empty array with no real level is corrupt, not a choice.
    return valid.length === 0 && levels.length > 0 ? DEFAULT_FILTERS.priorities : new Set(valid);
  } catch {
    return DEFAULT_FILTERS.priorities;
  }
}

function loadSidebar(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function loadPlanned(): BoardFilters['planned'] {
  try {
    const raw = localStorage.getItem(PLANNED_KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (typeof value !== 'object' || value === null) return DEFAULT_FILTERS.planned;
    const { on, days } = value as Record<string, unknown>;
    return {
      on: on === true,
      days:
        typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= 365
          ? days
          : DEFAULT_FILTERS.planned.days,
    };
  } catch {
    return DEFAULT_FILTERS.planned;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be blocked; the setting then lasts for this visit only.
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
  // Only for list changes, which go straight to Google rather than through the queue.
  google: GoogleApi;
}

export function App({ store, engine, auth, google }: Props) {
  const snapshot = useSnapshot(store);
  const status = useSyncStatus(engine);
  const phone = useIsPhone();
  const [{ view, taskId }, setRoute] = useState(readRoute);
  const [filter, setFilter] = useState(loadFilter);
  const [priorities, setPriorities] = useState(loadPriorities);
  const [planned, setPlanned] = useState(loadPlanned);
  const [selecting, setSelecting] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebar);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => () => clearTimeout(errorTimer.current), []);

  // Select mode belongs to the board; the drawer closes whenever the page changes.
  useEffect(() => {
    if (view !== 'board') setSelecting(false);
    setDrawerOpen(false);
  }, [view]);

  useEffect(() => {
    if (!phone) setDrawerOpen(false);
  }, [phone]);

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

  const filters = useMemo<BoardFilters>(
    () => ({ lists: effectiveFilter, priorities, planned }),
    [effectiveFilter, priorities, planned],
  );

  function changeFilters(next: BoardFilters) {
    if (next.lists !== filters.lists) {
      const lists = next.lists ? new Set(next.lists) : null;
      setFilter(lists);
      saveFilter(lists);
    }
    if (next.priorities !== filters.priorities) {
      setPriorities(next.priorities);
      save(PRIORITIES_KEY, [...next.priorities]);
    }
    if (next.planned !== filters.planned) {
      setPlanned(next.planned);
      save(PLANNED_KEY, next.planned);
    }
  }

  function toggleSidebar() {
    const next = !sidebarOpen;
    setSidebarOpen(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? 'open' : 'closed');
    } catch {
      // Storage can be blocked; the choice then lasts for this visit only.
    }
  }

  function toggleSelect() {
    // The drawer would cover the cards that are about to become tappable.
    if (!selecting) setDrawerOpen(false);
    setSelecting(!selecting);
  }

  // Plain words rather than an HTTP status: list changes need Google to answer now.
  const listChange = (what: string, fn: () => Promise<unknown>) =>
    act(async () => {
      try {
        await fn();
      } catch (e) {
        throw new Error(
          e instanceof OfflineError
            ? `Couldn't ${what}: you're offline.`
            : e instanceof PendingMoveError
              ? `Couldn't ${what}: wait for your changes to sync, then try again.`
              : `Couldn't ${what}. Try again in a moment.`,
        );
      }
    });

  const sidebarProps = {
    lists: snapshot.lists,
    tasks: snapshot.tasks,
    defaultListId: snapshot.defaultListId,
    onCreateList: (title: string) =>
      listChange('create the list', async () => {
        const list = await createList(google, store, title);
        // A list someone has just made should show, even with others unticked.
        if (filter) {
          const next = new Set(filter).add(list.id);
          setFilter(next);
          saveFilter(next);
        }
      }),
    onRenameList: (id: string, title: string) =>
      listChange('rename the list', () => renameList(google, store, id, title)),
    onDeleteList: (id: string) =>
      listChange('delete the list', async () => {
        await deleteList(google, store, id);
        if (filter?.has(id)) {
          const next = new Set(filter);
          next.delete(id);
          const kept = next.size > 0 ? next : null;
          setFilter(kept);
          saveFilter(kept);
        }
      }),
    filters,
    onFilters: changeFilters,
    selecting,
    onToggleSelect: toggleSelect,
    showSelect: view === 'board',
  };

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
        menu={{
          filtersOn: (filters.lists ? 1 : 0) + activeFilterCount(filters),
          expanded: phone ? drawerOpen : sidebarOpen,
          onClick: phone ? () => setDrawerOpen(true) : toggleSidebar,
        }}
      />
      <div class={phone ? undefined : 'with-sidebar'}>
        {!phone && sidebarOpen && <Sidebar {...sidebarProps} />}
        <main class="main">
          {view === 'today' ? (
            <Today store={store} snapshot={snapshot} filters={filters} phone={phone} act={act} />
          ) : (
            <Board
              store={store}
              snapshot={snapshot}
              filters={filters}
              phone={phone}
              act={act}
              selecting={selecting}
              onSelecting={setSelecting}
            />
          )}
        </main>
      </div>
      {phone && (
        <SidebarDrawer {...sidebarProps} open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      )}
      {phone && (
        <PhoneNav
          route={view}
          lists={snapshot.lists}
          defaultListId={snapshot.lastListId}
          onAdd={(input) =>
            act(async () => {
              await addTask(store, input, new Date().toISOString());
            })
          }
        />
      )}
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
