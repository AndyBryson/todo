import { completeEntry, placeInColumn, reopenEntry } from '../domain/board';
import { appendRank } from '../domain/rank';
import type { BoardEntries, BoardEntry, Column, Task } from '../domain/types';
import type { TaskPatch } from '../google/api';
import type { Store } from './db';

function requireTask(store: Store, taskId: string): Task {
  const task = store.snapshot().tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Unknown task ${taskId}`);
  return task;
}

function requireEntry(store: Store, taskId: string): BoardEntry {
  const entry = store.snapshot().entries[taskId];
  if (!entry) throw new Error(`Task ${taskId} has no board card`);
  return entry;
}

function stamp(changes: BoardEntries, now: string): BoardEntries {
  const stamped: BoardEntries = {};
  for (const [id, e] of Object.entries(changes)) stamped[id] = { ...e, updatedAt: now };
  return stamped;
}

export async function addTask(
  store: Store,
  input: { listId: string; title: string; pinned: boolean },
  now: string,
): Promise<string> {
  const title = input.title.trim();
  if (!title) throw new Error('A task needs a title');

  const id = `local-${crypto.randomUUID()}`;
  const backlog = Object.values(store.snapshot().entries)
    .filter((e) => e.column === 'Backlog')
    .map((e) => e.rank);

  await store.putTask({
    id,
    listId: input.listId,
    title,
    notes: '',
    due: null,
    completed: false,
    completedAt: null,
    parent: null,
    position: '', // Google assigns the real position on create
    updated: now,
  });
  await store.patchEntries({
    [id]: {
      column: 'Backlog',
      rank: appendRank(backlog),
      pinned: input.pinned,
      openColumn: 'Backlog',
      updatedAt: now,
    },
  });
  await store.enqueue({ kind: 'create', listId: input.listId, tempId: id, task: { title } });
  await store.setMeta({ lastListId: input.listId });
  return id;
}

export async function editTask(
  store: Store,
  taskId: string,
  set: Pick<TaskPatch, 'title' | 'notes' | 'due'>,
): Promise<void> {
  const task = requireTask(store, taskId);
  const base: TaskPatch = {};
  for (const key of Object.keys(set) as (keyof typeof set)[]) {
    (base as Record<string, unknown>)[key] = task[key];
  }
  await store.putTask({ ...task, ...set });
  await store.enqueue({ kind: 'patch', listId: task.listId, taskId, set, base });
}

export async function setCompleted(
  store: Store,
  taskId: string,
  completed: boolean,
  now: string,
): Promise<void> {
  const task = requireTask(store, taskId);
  await store.putTask({ ...task, completed, completedAt: completed ? now : null });

  const { entries } = store.snapshot();
  const entry = entries[taskId];
  if (entry) {
    if (completed) {
      await store.patchEntries({ [taskId]: completeEntry(entry, now) });
    } else if (entry.column === 'Done') {
      await store.patchEntries({ [taskId]: reopenEntry(entry, entries, now) });
    }
  }
  await store.enqueue({
    kind: 'patch',
    listId: task.listId,
    taskId,
    set: { completed },
    base: { completed: task.completed },
  });
}

export async function moveCard(
  store: Store,
  taskId: string,
  column: Column,
  insertAfter: string | null,
  now: string,
): Promise<void> {
  requireTask(store, taskId);
  const entry = requireEntry(store, taskId);

  if (column === 'Done') {
    if (entry.column !== 'Done') await setCompleted(store, taskId, true, now);
    return;
  }
  if (entry.column === 'Done') await setCompleted(store, taskId, false, now);

  const changes = placeInColumn(store.snapshot().entries, taskId, column, insertAfter);
  await store.patchEntries(stamp(changes, now));
}

export async function setPinned(
  store: Store,
  taskId: string,
  pinned: boolean,
  now: string,
): Promise<void> {
  requireTask(store, taskId);
  const entry = requireEntry(store, taskId);
  await store.patchEntries({ [taskId]: { ...entry, pinned, updatedAt: now } });
}

export async function moveToList(store: Store, taskId: string, toListId: string): Promise<void> {
  const task = requireTask(store, taskId);
  if (task.listId === toListId) return;

  const family = store.snapshot().tasks.filter((t) => t.id === taskId || t.parent === taskId);
  for (const t of family) await store.putTask({ ...t, listId: toListId });
  await store.enqueue({ kind: 'move', listId: task.listId, taskId, toListId });
}

export async function deleteTask(store: Store, taskId: string): Promise<void> {
  const task = requireTask(store, taskId);
  const subtasks = store.snapshot().tasks.filter((t) => t.parent === taskId);
  for (const t of subtasks) await store.removeTask(t.id);
  await store.removeTask(taskId);
  await store.patchEntries({}, [taskId]);
  // Google deletes subtasks with their parent, so one op covers them all.
  await store.enqueue({ kind: 'delete', listId: task.listId, taskId });
}
