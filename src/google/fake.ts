import type { Task, TaskList } from '../domain/types';
import { type GoogleApi, NotFoundError } from './api';

export interface FakeGoogle extends GoogleApi {
  lists: TaskList[];
  tasks: Map<string, Task>;
  board: { raw: string | null; version: number };
  failOn(method: keyof GoogleApi, error: Error, opts?: { after?: number; times?: number }): void;
  onAfter(method: keyof GoogleApi, fn: () => void): void;
  calls: { method: string; args: unknown[] }[];
}

interface Failure {
  error: Error;
  after: number;
  times: number;
  seen: number;
}

// Google positions are zero-padded digit strings.
export const fakePosition = (n: number | bigint) => String(n).padStart(20, '0');

export function createFakeGoogle(seed?: {
  lists?: TaskList[];
  tasks?: Task[];
  board?: string;
  // Real Google spaces sibling positions widely; tests that mix local and Google
  // positions need the same, or they cannot tell the two schemes apart.
  positionSpacing?: number;
}): FakeGoogle {
  const spacing = BigInt(seed?.positionSpacing ?? 1);
  const lists = [...(seed?.lists ?? [])];
  const tasks = new Map<string, Task>();
  for (const t of seed?.tasks ?? []) tasks.set(t.id, { ...t });
  const board = {
    raw: seed?.board ?? null,
    version: seed?.board === undefined ? 0 : 1,
  };
  const calls: { method: string; args: unknown[] }[] = [];
  const failures = new Map<string, Failure[]>();
  const hooks = new Map<string, (() => void)[]>();
  let idCounter = 0;

  async function run<T>(method: keyof GoogleApi, args: unknown[], fn: () => T): Promise<T> {
    calls.push({ method, args });
    for (const f of failures.get(method) ?? []) {
      f.seen += 1;
      if (f.seen > f.after && f.seen <= f.after + f.times) throw f.error;
    }
    const result = fn();
    const hook = hooks.get(method)?.shift();
    hook?.();
    return result;
  }

  const requireList = (listId: string) => {
    if (!lists.some((l) => l.id === listId)) throw new NotFoundError(`list ${listId}`);
  };
  const requireTask = (listId: string, taskId: string) => {
    const t = tasks.get(taskId);
    if (!t || t.listId !== listId) throw new NotFoundError(`task ${taskId}`);
    return t;
  };
  const subtasksOf = (id: string) => [...tasks.values()].filter((t) => t.parent === id);
  // Positions outgrow Number precision, so compare them as integers.
  const byPosition = (a: Task, b: Task) => {
    const [x, y] = [BigInt(a.position), BigInt(b.position)];
    return x < y ? -1 : x > y ? 1 : 0;
  };

  return {
    lists,
    tasks,
    board,
    calls,

    failOn(method, error, opts) {
      const entry: Failure = {
        error,
        after: opts?.after ?? 0,
        times: opts?.times ?? Number.POSITIVE_INFINITY,
        seen: 0,
      };
      failures.set(method, [...(failures.get(method) ?? []), entry]);
    },

    onAfter(method, fn) {
      hooks.set(method, [...(hooks.get(method) ?? []), fn]);
    },

    listTaskLists() {
      return run('listTaskLists', [], () => lists.map((l) => ({ ...l })));
    },

    listTasks(listId, completedSince) {
      return run('listTasks', [listId, completedSince], () => {
        requireList(listId);
        return [...tasks.values()]
          .filter(
            (t) =>
              t.listId === listId &&
              (!t.completed || (t.completedAt !== null && t.completedAt >= completedSince)),
          )
          .map((t) => ({ ...t }));
      });
    },

    getTask(listId, taskId) {
      return run('getTask', [listId, taskId], () => ({ ...requireTask(listId, taskId) }));
    },

    insertTask(listId, input) {
      return run('insertTask', [listId, input], () => {
        requireList(listId);
        if (input.parent) requireTask(listId, input.parent);
        const parent = input.parent ?? null;
        const siblings = [...tasks.values()]
          .filter((t) => t.listId === listId && t.parent === parent)
          .sort(byPosition);
        let index = 0;
        if (input.previous) {
          const at = siblings.findIndex((s) => s.id === input.previous);
          if (at === -1) throw new NotFoundError(`task ${input.previous}`);
          index = at + 1;
        }
        idCounter += 1;
        const task: Task = {
          id: `${Math.random().toString(36).slice(2, 10)}${idCounter}`,
          listId,
          title: input.title,
          notes: input.notes ?? '',
          due: input.due ?? null,
          completed: false,
          completedAt: null,
          parent: input.parent ?? null,
          position: '',
          updated: new Date().toISOString(),
        };
        tasks.set(task.id, task);
        siblings.splice(index, 0, task);
        siblings.forEach((s, i) => {
          s.position = fakePosition(BigInt(i) * spacing);
        });
        return { ...task };
      });
    },

    patchTask(listId, taskId, patch) {
      return run('patchTask', [listId, taskId, patch], () => {
        const t = requireTask(listId, taskId);
        const now = new Date().toISOString();
        if (patch.title !== undefined) t.title = patch.title;
        if (patch.notes !== undefined) t.notes = patch.notes;
        if (patch.due !== undefined) t.due = patch.due;
        if (patch.completed !== undefined) {
          t.completed = patch.completed;
          t.completedAt = patch.completed ? now : null;
        }
        t.updated = now;
        return { ...t };
      });
    },

    deleteTask(listId, taskId) {
      return run('deleteTask', [listId, taskId], () => {
        requireTask(listId, taskId);
        for (const sub of subtasksOf(taskId)) tasks.delete(sub.id);
        tasks.delete(taskId);
      });
    },

    moveTask(listId, taskId, destinationListId) {
      return run('moveTask', [listId, taskId, destinationListId], () => {
        const t = requireTask(listId, taskId);
        requireList(destinationListId);
        for (const sub of subtasksOf(taskId)) sub.listId = destinationListId;
        t.listId = destinationListId;
        t.updated = new Date().toISOString();
        return { ...t };
      });
    },

    reorderTask(listId, taskId, parent, previous) {
      return run('reorderTask', [listId, taskId, parent, previous], () => {
        const t = requireTask(listId, taskId);
        requireTask(listId, parent);
        const siblings = subtasksOf(parent)
          .filter((s) => s.id !== taskId)
          .sort(byPosition);
        let index = 0;
        if (previous !== null) {
          requireTask(listId, previous);
          const at = siblings.findIndex((s) => s.id === previous);
          if (at === -1) throw new NotFoundError(`task ${previous} under ${parent}`);
          index = at + 1;
        }
        siblings.splice(index, 0, t);
        t.parent = parent;
        t.updated = new Date().toISOString();
        siblings.forEach((s, i) => {
          s.position = fakePosition(BigInt(i) * spacing);
        });
        return { ...t };
      });
    },

    readBoard() {
      return run('readBoard', [], () =>
        board.raw === null
          ? { raw: null, version: null }
          : { raw: board.raw, version: String(board.version) },
      );
    },

    writeBoard(raw, expectedVersion) {
      return run('writeBoard', [raw, expectedVersion], () => {
        const current = board.raw === null ? null : String(board.version);
        if (expectedVersion !== current) return 'conflict' as const;
        board.raw = raw;
        board.version += 1;
        return 'ok' as const;
      });
    },
  };
}
