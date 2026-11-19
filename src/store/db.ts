import {
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  openDB,
  type StoreNames,
} from 'idb';
import type { BoardEntries, Task, TaskList } from '../domain/types';
import type { NewTask, TaskPatch } from '../google/api';

// What the original looked like when it was copied to another account, so the delete
// that finishes the move can tell whether it was edited elsewhere in the meantime.
export interface Fingerprint {
  updated: string;
  // Step ID to the step's `updated`.
  steps: Record<string, string>;
}

export type Op =
  // attemptedAt is set before the first insert, so a replay after a lost response can find the task it made.
  | { kind: 'create'; listId: string; tempId: string; task: NewTask; attemptedAt?: string }
  | { kind: 'patch'; listId: string; taskId: string; set: TaskPatch; base: TaskPatch }
  | { kind: 'delete'; listId: string; taskId: string }
  | { kind: 'move'; listId: string; taskId: string; toListId: string }
  | { kind: 'reorder'; listId: string; taskId: string; parent: string; previous: string | null }
  // Queued in the target account after the copy's creates. taskId is the copy's.
  | {
      kind: 'handoff';
      listId: string;
      taskId: string;
      source: { accountId: string; listId: string; taskId: string; title: string };
      fingerprint: Fingerprint;
    }
  // Queued in the source account once the copy exists. taskId is the original's.
  | {
      kind: 'transferDelete';
      listId: string;
      taskId: string;
      title: string;
      fingerprint: Fingerprint;
    };

export interface QueuedOp {
  seq: number;
  op: Op;
}

export interface Notice {
  id: string;
  text: string;
}

export interface Snapshot {
  lists: TaskList[];
  tasks: Task[];
  entries: BoardEntries;
  queueLength: number;
  queued: QueuedOp[];
  notices: Notice[];
  lastSyncedAt: string | null;
  lastListId: string | null;
  // Google's default list (My Tasks); null until a pull has learnt it.
  defaultListId: string | null;
  // Old temporary ID to real ID, for this session only: an open screen or a late
  // edit can still hold the temporary ID after a replay has renamed the task.
  renamed: Record<string, string>;
  // Source task ID to target account ID, for originals whose move is still under way.
  hidden: Record<string, string>;
}

// One edit's worth of changes. Applied together or not at all.
export interface Change {
  // Replace the whole Google mirror (lists and tasks); put/remove below apply on top.
  replaceRemote?: { lists: TaskList[]; tasks: Task[] };
  // Applied after replaceRemote. putLists replaces a list with the same ID.
  putLists?: TaskList[];
  removeLists?: string[];
  putTasks?: Task[];
  removeTasks?: string[];
  // Replaces every entry; `entries` and `removeEntries` apply on top.
  replaceEntries?: BoardEntries;
  entries?: BoardEntries;
  removeEntries?: string[];
  enqueue?: Op[];
  dequeue?: number[];
  // Replaces the op at each seq; a seq also in `dequeue` is dropped instead.
  requeue?: QueuedOp[];
  notices?: string[];
  removeNotices?: string[];
  meta?: Partial<Meta>;
  renamed?: Record<string, string>;
}

// Rewrites every reference to fromId in one queued op, or returns null if it has none.
function renameInOp(op: Op, fromId: string, toId: string): Op | null {
  const swap = (id: string) => (id === fromId ? toId : id);
  switch (op.kind) {
    case 'create':
      return op.task.parent === fromId || op.task.previous === fromId
        ? {
            ...op,
            task: {
              ...op.task,
              ...(op.task.parent === fromId && { parent: toId }),
              ...(op.task.previous === fromId && { previous: toId }),
            },
          }
        : null;
    case 'reorder':
      return op.taskId === fromId || op.parent === fromId || op.previous === fromId
        ? {
            ...op,
            taskId: swap(op.taskId),
            parent: swap(op.parent),
            previous: op.previous === null ? null : swap(op.previous),
          }
        : null;
    default:
      return op.taskId === fromId ? { ...op, taskId: toId } : null;
  }
}

// Moves a task, its subtasks, its board entry and its queued ops to a new ID.
export function renameChange(s: Snapshot, fromId: string, toId: string): Change {
  const family = s.tasks.filter((t) => t.id === fromId || t.parent === fromId);
  const entry = s.entries[fromId];
  return {
    putTasks: family.map((t) => (t.id === fromId ? { ...t, id: toId } : { ...t, parent: toId })),
    removeTasks: family.some((t) => t.id === fromId) ? [fromId] : [],
    entries: entry ? { [toId]: entry } : undefined,
    removeEntries: entry ? [fromId] : [],
    renamed: { [fromId]: toId },
    requeue: s.queued.flatMap((q) => {
      const op = renameInOp(q.op, fromId, toId);
      return op ? [{ seq: q.seq, op }] : [];
    }),
  };
}

export interface Store {
  // A function is run inside the write queue against the latest committed state,
  // so concurrent edits never build on a stale read. Throwing rejects with no change;
  // an empty change is a no-op.
  commit(change: Change | ((current: Snapshot) => Change)): Promise<void>;
  snapshot(): Snapshot;
  subscribe(fn: () => void): () => void;
  dismissNotice(id: string): Promise<void>;
  setMeta(meta: Partial<Meta>): Promise<void>;
}

interface Schema extends DBSchema {
  lists: { key: string; value: TaskList };
  tasks: { key: string; value: Task };
  entries: { key: string; value: BoardEntries[string] };
  queue: { key: number; value: { seq: number; op: Op } };
  notices: { key: string; value: Notice };
  meta: { key: string; value: string | null };
}

type Db = IDBPDatabase<Schema>;
type Tx = IDBPTransaction<Schema, StoreNames<Schema>[], 'readwrite'>;
export type Meta = Pick<Snapshot, 'lastSyncedAt' | 'lastListId' | 'defaultListId' | 'hidden'>;

function parseHidden(raw: string | null | undefined): Record<string, string> {
  try {
    const value: unknown = JSON.parse(raw ?? '');
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

const STORES: StoreNames<Schema>[] = ['lists', 'tasks', 'entries', 'queue', 'notices', 'meta'];

interface State {
  lists: TaskList[];
  tasks: Task[];
  entries: BoardEntries;
  queued: QueuedOp[];
  notices: Notice[];
  meta: Meta;
  renamed: Record<string, string>;
}

interface Plan {
  next: Partial<State>;
  persist: (tx: Tx) => Promise<unknown>[];
  seq?: number;
}

// onClosed runs when another window holds or needs the database, so this window
// must stop using it rather than hang an upgrade.
export async function openStore(name = 'todo', onClosed?: () => void): Promise<Store> {
  const db: Db = await openDB<Schema>(name, 1, {
    blocked() {
      onClosed?.();
    },
    blocking() {
      db.close();
      onClosed?.();
    },
    upgrade(d) {
      d.createObjectStore('lists', { keyPath: 'id' });
      d.createObjectStore('tasks', { keyPath: 'id' });
      d.createObjectStore('entries');
      d.createObjectStore('queue', { keyPath: 'seq' });
      d.createObjectStore('notices', { keyPath: 'id' });
      d.createObjectStore('meta');
    },
  });

  const entries: BoardEntries = {};
  for (const key of await db.getAllKeys('entries')) {
    const value = await db.get('entries', key);
    if (value) entries[key] = value;
  }
  let state: State = {
    lists: await db.getAll('lists'),
    tasks: await db.getAll('tasks'),
    entries,
    queued: (await db.getAll('queue'))
      .map((q) => ({ seq: q.seq, op: q.op }))
      .sort((a, b) => a.seq - b.seq),
    notices: await db.getAll('notices'),
    meta: {
      lastSyncedAt: (await db.get('meta', 'lastSyncedAt')) ?? null,
      lastListId: (await db.get('meta', 'lastListId')) ?? null,
      defaultListId: (await db.get('meta', 'defaultListId')) ?? null,
      hidden: parseHidden(await db.get('meta', 'hidden')),
    },
    renamed: {},
  };
  let lastSeq = state.queued.reduce((max, q) => Math.max(max, q.seq), 0);

  // Rebuilt only after a write, so identity changes exactly when something did.
  let current: Snapshot | null = null;
  const listeners = new Set<() => void>();

  const view = (s: State): Snapshot => ({
    lists: s.lists,
    tasks: s.tasks,
    entries: s.entries,
    queueLength: s.queued.length,
    queued: s.queued,
    notices: s.notices,
    ...s.meta,
    renamed: s.renamed,
  });

  function snapshot(): Snapshot {
    current ??= view(state);
    return current;
  }

  // Writes run one at a time, each planned from the state the previous one left.
  // Persist first, swap and notify only on success, so a failed write changes nothing.
  let chain: Promise<unknown> = Promise.resolve();
  function mutate(plan: (s: State, nextSeq: number) => Plan | null): Promise<void> {
    const run = async () => {
      const p = plan(state, lastSeq + 1);
      if (!p) return;
      const tx = db.transaction(STORES, 'readwrite');
      // Track every request as it is issued: if building the rest throws (an
      // unclonable value), the ones already issued must still be awaited and silenced.
      const issued: Promise<unknown>[] = [tx.done];
      const tracked = {
        objectStore: (storeName: StoreNames<Schema>) =>
          new Proxy(tx.objectStore(storeName), {
            get(target, prop) {
              const member = Reflect.get(target, prop, target);
              if (typeof member !== 'function') return member;
              return (...args: unknown[]) => {
                const result = member.apply(target, args);
                issued.push(result);
                return result;
              };
            },
          }),
      } as unknown as Tx;
      try {
        p.persist(tracked);
        await Promise.all(issued);
      } catch (error) {
        for (const request of issued) request.catch(() => undefined);
        try {
          tx.abort();
        } catch {
          // Already finished or aborted.
        }
        throw error;
      }
      state = { ...state, ...p.next };
      if (p.seq !== undefined) lastSeq = p.seq;
      current = null;
      for (const fn of [...listeners]) fn();
    };
    const result = chain.then(run, run);
    chain = result.catch(() => undefined);
    return result;
  }

  const putQueue = (tx: Tx, qs: QueuedOp[]) =>
    qs.map((q) => tx.objectStore('queue').put({ seq: q.seq, op: q.op }));

  function commit(input: Change | ((current: Snapshot) => Change)): Promise<void> {
    return mutate((s, nextSeq) => {
      const change = typeof input === 'function' ? input(view(s)) : input;
      const next: Partial<State> = {};
      const putTasks = change.putTasks ?? [];
      const removeTasks = change.removeTasks ?? [];
      const putLists = change.putLists ?? [];
      const removeLists = change.removeLists ?? [];
      if (change.replaceRemote || putLists.length || removeLists.length) {
        const lists = new Map((change.replaceRemote?.lists ?? s.lists).map((l) => [l.id, l]));
        for (const id of removeLists) lists.delete(id);
        for (const l of putLists) lists.set(l.id, l);
        next.lists = [...lists.values()];
      }
      if (change.replaceRemote || putTasks.length || removeTasks.length) {
        const byId = new Map((change.replaceRemote?.tasks ?? s.tasks).map((t) => [t.id, t]));
        for (const id of removeTasks) byId.delete(id);
        for (const t of putTasks) byId.set(t.id, t);
        next.tasks = [...byId.values()];
      }
      const removeEntries = change.removeEntries ?? [];
      if (change.replaceEntries || change.entries || removeEntries.length) {
        const board = { ...(change.replaceEntries ?? s.entries), ...change.entries };
        for (const id of removeEntries) delete board[id];
        next.entries = board;
      }
      const added: QueuedOp[] = (change.enqueue ?? []).map((op, i) => ({
        seq: nextSeq + i,
        op,
      }));
      const dequeued = new Set(change.dequeue ?? []);
      const requeued = new Map((change.requeue ?? []).map((q) => [q.seq, q.op]));
      if (dequeued.size || requeued.size || added.length) {
        next.queued = [
          ...s.queued
            .filter((q) => !dequeued.has(q.seq))
            .map((q) => ({ seq: q.seq, op: requeued.get(q.seq) ?? q.op })),
          ...added,
        ];
      }
      const notices = (change.notices ?? []).map((text) => ({ id: crypto.randomUUID(), text }));
      const removeNotices = new Set(change.removeNotices ?? []);
      if (notices.length || removeNotices.size) {
        next.notices = [...s.notices.filter((n) => !removeNotices.has(n.id)), ...notices];
      }
      if (change.meta) next.meta = { ...s.meta, ...change.meta };
      if (change.renamed) next.renamed = { ...s.renamed, ...change.renamed };

      if (Object.keys(next).length === 0) return null;

      return {
        next,
        seq: added.length ? nextSeq + added.length - 1 : undefined,
        persist: (tx) => [
          ...(change.replaceRemote
            ? [
                tx.objectStore('lists').clear(),
                tx.objectStore('tasks').clear(),
                ...change.replaceRemote.lists.map((l) => tx.objectStore('lists').put(l)),
              ]
            : []),
          ...removeLists.map((id) => tx.objectStore('lists').delete(id)),
          ...putLists.map((l) => tx.objectStore('lists').put(l)),
          ...(change.replaceEntries ? [tx.objectStore('entries').clear()] : []),
          ...(change.replaceRemote?.tasks ?? []).map((t) => tx.objectStore('tasks').put(t)),
          ...(change.replaceEntries
            ? Object.entries(change.replaceEntries).map(([id, e]) =>
                tx.objectStore('entries').put(e, id),
              )
            : []),
          ...putTasks.map((t) => tx.objectStore('tasks').put(t)),
          ...removeTasks.map((id) => tx.objectStore('tasks').delete(id)),
          ...Object.entries(change.entries ?? {}).map(([id, e]) =>
            tx.objectStore('entries').put(e, id),
          ),
          ...removeEntries.map((id) => tx.objectStore('entries').delete(id)),
          ...putQueue(tx, added),
          ...putQueue(
            tx,
            [...requeued].filter(([seq]) => !dequeued.has(seq)).map(([seq, op]) => ({ seq, op })),
          ),
          ...[...dequeued].map((seq) => tx.objectStore('queue').delete(seq)),
          ...notices.map((n) => tx.objectStore('notices').put(n)),
          ...[...removeNotices].map((id) => tx.objectStore('notices').delete(id)),
          ...Object.entries(change.meta ?? {}).map(([k, v]) =>
            tx
              .objectStore('meta')
              .put(k === 'hidden' ? JSON.stringify(v) : (v as string | null), k),
          ),
        ],
      };
    });
  }

  return {
    commit,
    snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    dismissNotice(id) {
      return commit({ removeNotices: [id] });
    },

    setMeta(patch) {
      return commit({ meta: patch });
    },
  };
}
