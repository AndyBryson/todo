import {
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  openDB,
  type StoreNames,
} from 'idb';
import type { BoardEntries, Task, TaskList } from '../domain/types';
import type { NewTask, TaskPatch } from '../google/api';

export type Op =
  | { kind: 'create'; listId: string; tempId: string; task: NewTask }
  | { kind: 'patch'; listId: string; taskId: string; set: TaskPatch; base: TaskPatch }
  | { kind: 'delete'; listId: string; taskId: string }
  | { kind: 'move'; listId: string; taskId: string; toListId: string };

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
  notices: Notice[];
  lastSyncedAt: string | null;
  lastListId: string | null;
}

// One edit's worth of changes. Applied together or not at all.
export interface Change {
  putTasks?: Task[];
  removeTasks?: string[];
  entries?: BoardEntries;
  removeEntries?: string[];
  enqueue?: Op[];
  meta?: Partial<Meta>;
}

export interface Store {
  commit(change: Change): Promise<void>;
  snapshot(): Snapshot;
  subscribe(fn: () => void): () => void;
  replaceRemote(lists: TaskList[], tasks: Task[]): Promise<void>;
  putTask(task: Task): Promise<void>;
  removeTask(taskId: string): Promise<void>;
  setEntries(entries: BoardEntries): Promise<void>;
  patchEntries(changes: BoardEntries, removed?: string[]): Promise<void>;
  enqueue(op: Op): Promise<void>;
  queue(): Promise<QueuedOp[]>;
  dequeue(seq: number): Promise<void>;
  rewriteQueue(fn: (op: Op) => Op | null): Promise<void>;
  renameTask(fromId: string, toId: string): Promise<void>;
  addNotice(text: string): Promise<void>;
  dismissNotice(id: string): Promise<void>;
  setMeta(meta: Partial<Pick<Snapshot, 'lastSyncedAt' | 'lastListId'>>): Promise<void>;
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
export type Meta = Pick<Snapshot, 'lastSyncedAt' | 'lastListId'>;

const STORES: StoreNames<Schema>[] = ['lists', 'tasks', 'entries', 'queue', 'notices', 'meta'];

interface State {
  lists: TaskList[];
  tasks: Task[];
  entries: BoardEntries;
  queued: QueuedOp[];
  notices: Notice[];
  meta: Meta;
}

interface Plan {
  next: Partial<State>;
  persist: (tx: Tx) => Promise<unknown>[];
  seq?: number;
}

export async function openStore(name = 'todo'): Promise<Store> {
  const db: Db = await openDB<Schema>(name, 1, {
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
    },
  };
  let lastSeq = state.queued.reduce((max, q) => Math.max(max, q.seq), 0);

  // Rebuilt only after a write, so identity changes exactly when something did.
  let current: Snapshot | null = null;
  const listeners = new Set<() => void>();

  function snapshot(): Snapshot {
    current ??= {
      lists: state.lists,
      tasks: state.tasks,
      entries: state.entries,
      queueLength: state.queued.length,
      notices: state.notices,
      ...state.meta,
    };
    return current;
  }

  // Writes run one at a time, each planned from the state the previous one left.
  // Persist first, swap and notify only on success, so a failed write changes nothing.
  let chain: Promise<unknown> = Promise.resolve();
  function mutate(plan: (s: State, nextSeq: number) => Plan): Promise<void> {
    const run = async () => {
      const p = plan(state, lastSeq + 1);
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

  function commit(change: Change): Promise<void> {
    return mutate((s, nextSeq) => {
      const next: Partial<State> = {};
      const putTasks = change.putTasks ?? [];
      const removeTasks = change.removeTasks ?? [];
      if (putTasks.length || removeTasks.length) {
        const byId = new Map(s.tasks.map((t) => [t.id, t]));
        for (const id of removeTasks) byId.delete(id);
        for (const t of putTasks) byId.set(t.id, t);
        next.tasks = [...byId.values()];
      }
      const removeEntries = change.removeEntries ?? [];
      if (change.entries || removeEntries.length) {
        const board = { ...s.entries, ...change.entries };
        for (const id of removeEntries) delete board[id];
        next.entries = board;
      }
      const added: QueuedOp[] = (change.enqueue ?? []).map((op, i) => ({
        seq: nextSeq + i,
        op,
      }));
      if (added.length) next.queued = [...s.queued, ...added];
      if (change.meta) next.meta = { ...s.meta, ...change.meta };

      return {
        next,
        seq: added.length ? nextSeq + added.length - 1 : undefined,
        persist: (tx) => [
          ...putTasks.map((t) => tx.objectStore('tasks').put(t)),
          ...removeTasks.map((id) => tx.objectStore('tasks').delete(id)),
          ...Object.entries(change.entries ?? {}).map(([id, e]) =>
            tx.objectStore('entries').put(e, id),
          ),
          ...removeEntries.map((id) => tx.objectStore('entries').delete(id)),
          ...putQueue(tx, added),
          ...Object.entries(change.meta ?? {}).map(([k, v]) =>
            tx.objectStore('meta').put(v as string | null, k),
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

    replaceRemote(newLists, newTasks) {
      return mutate(() => ({
        next: { lists: [...newLists], tasks: [...newTasks] },
        persist: (tx) => [
          tx.objectStore('lists').clear(),
          tx.objectStore('tasks').clear(),
          ...newLists.map((l) => tx.objectStore('lists').put(l)),
          ...newTasks.map((t) => tx.objectStore('tasks').put(t)),
        ],
      }));
    },

    putTask(task) {
      return commit({ putTasks: [task] });
    },

    removeTask(taskId) {
      return commit({ removeTasks: [taskId] });
    },

    setEntries(next) {
      return mutate(() => ({
        next: { entries: { ...next } },
        persist: (tx) => [
          tx.objectStore('entries').clear(),
          ...Object.entries(next).map(([id, e]) => tx.objectStore('entries').put(e, id)),
        ],
      }));
    },

    patchEntries(changes, removed = []) {
      return commit({ entries: changes, removeEntries: removed });
    },

    enqueue(op) {
      return commit({ enqueue: [op] });
    },

    async queue() {
      return [...state.queued];
    },

    dequeue(seq) {
      return mutate((s) => ({
        next: { queued: s.queued.filter((q) => q.seq !== seq) },
        persist: (tx) => [tx.objectStore('queue').delete(seq)],
      }));
    },

    rewriteQueue(fn) {
      return mutate((s) => {
        const kept: QueuedOp[] = [];
        const dropped: QueuedOp[] = [];
        for (const q of s.queued) {
          const op = fn(q.op);
          if (op) kept.push({ seq: q.seq, op });
          else dropped.push(q);
        }
        return {
          next: { queued: kept },
          persist: (tx) => [
            ...putQueue(tx, kept),
            ...dropped.map((q) => tx.objectStore('queue').delete(q.seq)),
          ],
        };
      });
    },

    renameTask(fromId, toId) {
      return mutate((s) => {
        const renamed = (op: Op): Op =>
          op.kind !== 'create' && op.taskId === fromId ? { ...op, taskId: toId } : op;
        const queued = s.queued.map((q) => ({ seq: q.seq, op: renamed(q.op) }));
        const tasks = s.tasks.map((t) => {
          if (t.id === fromId) return { ...t, id: toId };
          return t.parent === fromId ? { ...t, parent: toId } : t;
        });
        const entry = s.entries[fromId];
        const board = { ...s.entries };
        if (entry) {
          board[toId] = entry;
          delete board[fromId];
        }
        return {
          next: { tasks, queued, entries: board },
          persist: (tx) => [
            tx.objectStore('tasks').delete(fromId),
            ...tasks.map((t) => tx.objectStore('tasks').put(t)),
            ...putQueue(tx, queued),
            ...(entry
              ? [
                  tx.objectStore('entries').delete(fromId),
                  tx.objectStore('entries').put(entry, toId),
                ]
              : []),
          ],
        };
      });
    },

    addNotice(text) {
      const notice = { id: crypto.randomUUID(), text };
      return mutate((s) => ({
        next: { notices: [...s.notices, notice] },
        persist: (tx) => [tx.objectStore('notices').put(notice)],
      }));
    },

    dismissNotice(id) {
      return mutate((s) => ({
        next: { notices: s.notices.filter((n) => n.id !== id) },
        persist: (tx) => [tx.objectStore('notices').delete(id)],
      }));
    },

    setMeta(patch) {
      return commit({ meta: patch });
    },
  };
}
