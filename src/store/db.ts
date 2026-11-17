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
  // attemptedAt is set before the first insert, so a replay after a lost response can find the task it made.
  | { kind: 'create'; listId: string; tempId: string; task: NewTask; attemptedAt?: string }
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
  queued: QueuedOp[];
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
  dequeue?: number[];
  // Replaces the op at each seq; a seq also in `dequeue` is dropped instead.
  requeue?: QueuedOp[];
  notices?: string[];
  meta?: Partial<Meta>;
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
    requeue: s.queued
      .filter((q) => q.op.kind !== 'create' && q.op.taskId === fromId)
      .map((q) => ({ seq: q.seq, op: { ...q.op, taskId: toId } as Op })),
  };
}

export interface Store {
  // A function is run inside the write queue against the latest committed state,
  // so concurrent edits never build on a stale read. Throwing rejects with no change;
  // an empty change is a no-op.
  commit(change: Change | ((current: Snapshot) => Change)): Promise<void>;
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

  const view = (s: State): Snapshot => ({
    lists: s.lists,
    tasks: s.tasks,
    entries: s.entries,
    queueLength: s.queued.length,
    queued: s.queued,
    notices: s.notices,
    ...s.meta,
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
      if (notices.length) next.notices = [...s.notices, ...notices];
      if (change.meta) next.meta = { ...s.meta, ...change.meta };

      if (Object.keys(next).length === 0) return null;

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
          ...putQueue(
            tx,
            [...requeued].filter(([seq]) => !dequeued.has(seq)).map(([seq, op]) => ({ seq, op })),
          ),
          ...[...dequeued].map((seq) => tx.objectStore('queue').delete(seq)),
          ...notices.map((n) => tx.objectStore('notices').put(n)),
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
      return commit({ dequeue: [seq] });
    },

    rewriteQueue(fn) {
      return commit((s) => {
        const dequeue: number[] = [];
        const requeue: QueuedOp[] = [];
        for (const q of s.queued) {
          const op = fn(q.op);
          if (!op) dequeue.push(q.seq);
          else if (op !== q.op) requeue.push({ seq: q.seq, op });
        }
        return { dequeue, requeue };
      });
    },

    renameTask(fromId, toId) {
      return commit((s) => renameChange(s, fromId, toId));
    },

    addNotice(text) {
      return commit({ notices: [text] });
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
