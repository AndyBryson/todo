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

export interface Store {
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
  queue: { key: number; value: { seq?: number; op: Op } };
  notices: { key: string; value: Notice };
  meta: { key: string; value: string | null };
}

type Db = IDBPDatabase<Schema>;
type Tx = IDBPTransaction<Schema, StoreNames<Schema>[], 'readwrite'>;
type Meta = Pick<Snapshot, 'lastSyncedAt' | 'lastListId'>;

const STORES: StoreNames<Schema>[] = ['lists', 'tasks', 'entries', 'queue', 'notices', 'meta'];

export async function openStore(name = 'todo'): Promise<Store> {
  const db: Db = await openDB<Schema>(name, 1, {
    upgrade(d) {
      d.createObjectStore('lists', { keyPath: 'id' });
      d.createObjectStore('tasks', { keyPath: 'id' });
      d.createObjectStore('entries');
      d.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
      d.createObjectStore('notices', { keyPath: 'id' });
      d.createObjectStore('meta');
    },
  });

  let lists = await db.getAll('lists');
  let tasks = await db.getAll('tasks');
  let notices = await db.getAll('notices');
  let queued: QueuedOp[] = (await db.getAll('queue')).map((q) => ({
    seq: q.seq as number,
    op: q.op,
  }));
  const entries: BoardEntries = {};
  const entryKeys = await db.getAllKeys('entries');
  for (const key of entryKeys) {
    const value = await db.get('entries', key);
    if (value) entries[key] = value;
  }
  let board: BoardEntries = entries;
  let meta: Meta = {
    lastSyncedAt: (await db.get('meta', 'lastSyncedAt')) ?? null,
    lastListId: (await db.get('meta', 'lastListId')) ?? null,
  };

  // Rebuilt only after a write, so identity changes exactly when something did.
  let current: Snapshot | null = null;
  const listeners = new Set<() => void>();

  function snapshot(): Snapshot {
    current ??= { lists, tasks, entries: board, queueLength: queued.length, notices, ...meta };
    return current;
  }

  // Memory first so the UI never waits on disk; persist, then notify.
  async function write(apply: () => void, persist: (tx: Tx) => Promise<unknown>[]): Promise<void> {
    apply();
    current = null;
    const tx = db.transaction(STORES, 'readwrite');
    await Promise.all([...persist(tx), tx.done]);
    for (const fn of [...listeners]) fn();
  }

  return {
    snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    replaceRemote(newLists, newTasks) {
      return write(
        () => {
          lists = [...newLists];
          tasks = [...newTasks];
        },
        (tx) => [
          tx.objectStore('lists').clear(),
          tx.objectStore('tasks').clear(),
          ...newLists.map((l) => tx.objectStore('lists').put(l)),
          ...newTasks.map((t) => tx.objectStore('tasks').put(t)),
        ],
      );
    },

    putTask(task) {
      return write(
        () => {
          const i = tasks.findIndex((t) => t.id === task.id);
          tasks = i === -1 ? [...tasks, task] : tasks.map((t, j) => (j === i ? task : t));
        },
        (tx) => [tx.objectStore('tasks').put(task)],
      );
    },

    removeTask(taskId) {
      return write(
        () => {
          tasks = tasks.filter((t) => t.id !== taskId);
        },
        (tx) => [tx.objectStore('tasks').delete(taskId)],
      );
    },

    setEntries(next) {
      return write(
        () => {
          board = { ...next };
        },
        (tx) => [
          tx.objectStore('entries').clear(),
          ...Object.entries(next).map(([id, e]) => tx.objectStore('entries').put(e, id)),
        ],
      );
    },

    patchEntries(changes, removed = []) {
      return write(
        () => {
          board = { ...board, ...changes };
          for (const id of removed) delete board[id];
        },
        (tx) => [
          ...Object.entries(changes).map(([id, e]) => tx.objectStore('entries').put(e, id)),
          ...removed.map((id) => tx.objectStore('entries').delete(id)),
        ],
      );
    },

    async enqueue(op) {
      // The seq comes from IndexedDB, so the add must finish before memory is updated.
      const tx = db.transaction('queue', 'readwrite');
      const seq = (await tx.store.add({ op })) as number;
      await tx.done;
      await write(
        () => {
          queued = [...queued, { seq, op }];
        },
        () => [],
      );
    },

    async queue() {
      return [...queued];
    },

    dequeue(seq) {
      return write(
        () => {
          queued = queued.filter((q) => q.seq !== seq);
        },
        (tx) => [tx.objectStore('queue').delete(seq)],
      );
    },

    rewriteQueue(fn) {
      const next: QueuedOp[] = [];
      for (const q of queued) {
        const op = fn(q.op);
        if (op) next.push({ seq: q.seq, op });
      }
      const dropped = queued.filter((q) => !next.some((n) => n.seq === q.seq));
      return write(
        () => {
          queued = next;
        },
        (tx) => [
          ...next.map((q) => tx.objectStore('queue').put({ seq: q.seq, op: q.op })),
          ...dropped.map((q) => tx.objectStore('queue').delete(q.seq)),
        ],
      );
    },

    renameTask(fromId, toId) {
      const renamed = (op: Op): Op =>
        op.kind !== 'create' && op.taskId === fromId ? { ...op, taskId: toId } : op;
      const next = queued.map((q) => ({ seq: q.seq, op: renamed(q.op) }));
      const entry = board[fromId];
      return write(
        () => {
          tasks = tasks.map((t) => {
            if (t.id === fromId) return { ...t, id: toId };
            return t.parent === fromId ? { ...t, parent: toId } : t;
          });
          queued = next;
          if (entry) {
            board = { ...board, [toId]: entry };
            delete board[fromId];
          }
        },
        (tx) => [
          tx.objectStore('tasks').delete(fromId),
          ...tasks.map((t) => tx.objectStore('tasks').put(t)),
          ...next.map((q) => tx.objectStore('queue').put({ seq: q.seq, op: q.op })),
          ...(entry
            ? [tx.objectStore('entries').delete(fromId), tx.objectStore('entries').put(entry, toId)]
            : []),
        ],
      );
    },

    addNotice(text) {
      const notice = { id: crypto.randomUUID(), text };
      return write(
        () => {
          notices = [...notices, notice];
        },
        (tx) => [tx.objectStore('notices').put(notice)],
      );
    },

    dismissNotice(id) {
      return write(
        () => {
          notices = notices.filter((n) => n.id !== id);
        },
        (tx) => [tx.objectStore('notices').delete(id)],
      );
    },

    setMeta(patch) {
      return write(
        () => {
          meta = { ...meta, ...patch };
        },
        (tx) =>
          Object.entries(patch).map(([k, v]) => tx.objectStore('meta').put(v as string | null, k)),
      );
    },
  };
}
