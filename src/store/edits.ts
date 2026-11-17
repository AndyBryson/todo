import { completeEntry, placeInColumn, reopenEntry } from '../domain/board';
import { appendRank } from '../domain/rank';
import type { BoardEntries, BoardEntry, Column, Task } from '../domain/types';
import type { TaskPatch } from '../google/api';
import type { Change, Store } from './db';

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

  await store.commit({
    putTasks: [
      {
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
      },
    ],
    entries: {
      [id]: {
        column: 'Backlog',
        rank: appendRank(backlog),
        pinned: input.pinned,
        openColumn: 'Backlog',
        updatedAt: now,
      },
    },
    enqueue: [{ kind: 'create', listId: input.listId, tempId: id, task: { title } }],
    meta: { lastListId: input.listId },
  });
  return id;
}

export async function editTask(
  store: Store,
  taskId: string,
  input: Pick<TaskPatch, 'title' | 'notes' | 'due'>,
): Promise<void> {
  const task = requireTask(store, taskId);
  const set: TaskPatch = {};
  const base: TaskPatch = {};
  for (const key of ['title', 'notes', 'due'] as const) {
    if (input[key] === undefined) continue;
    (set as Record<string, unknown>)[key] = input[key];
    (base as Record<string, unknown>)[key] = task[key];
  }
  if (set.title !== undefined) {
    set.title = set.title.trim();
    if (!set.title) throw new Error('A task needs a title');
  }
  if (Object.keys(set).length === 0) return;

  await store.commit({
    putTasks: [{ ...task, ...set } as Task],
    enqueue: [{ kind: 'patch', listId: task.listId, taskId, set, base }],
  });
}

function completionChange(
  store: Store,
  task: Task,
  completed: boolean,
  now: string,
): Change | null {
  if (task.completed === completed) return null;
  const { entries } = store.snapshot();
  const entry = entries[task.id];
  let changed: BoardEntries | undefined;
  if (entry) {
    if (completed) changed = { [task.id]: completeEntry(entry, now) };
    else if (entry.column === 'Done') changed = { [task.id]: reopenEntry(entry, entries, now) };
  }
  return {
    putTasks: [{ ...task, completed, completedAt: completed ? now : null }],
    entries: changed,
    enqueue: [
      {
        kind: 'patch',
        listId: task.listId,
        taskId: task.id,
        set: { completed },
        base: { completed: task.completed },
      },
    ],
  };
}

export async function setCompleted(
  store: Store,
  taskId: string,
  completed: boolean,
  now: string,
): Promise<void> {
  const change = completionChange(store, requireTask(store, taskId), completed, now);
  if (change) await store.commit(change);
}

export async function moveCard(
  store: Store,
  taskId: string,
  column: Column,
  insertAfter: string | null,
  now: string,
): Promise<void> {
  const task = requireTask(store, taskId);
  const entry = requireEntry(store, taskId);

  if (column === 'Done') {
    if (entry.column !== 'Done') await setCompleted(store, taskId, true, now);
    return;
  }

  // Reopen and placement go in one commit so the card never shows in its old column.
  const reopen = entry.column === 'Done' ? completionChange(store, task, false, now) : null;
  const entries = { ...store.snapshot().entries, ...reopen?.entries };
  const placed = stamp(placeInColumn(entries, taskId, column, insertAfter), now);
  await store.commit({ ...reopen, entries: { ...reopen?.entries, ...placed } });
}

export async function setPinned(
  store: Store,
  taskId: string,
  pinned: boolean,
  now: string,
): Promise<void> {
  requireTask(store, taskId);
  const entry = requireEntry(store, taskId);
  await store.commit({ entries: { [taskId]: { ...entry, pinned, updatedAt: now } } });
}

export async function moveToList(store: Store, taskId: string, toListId: string): Promise<void> {
  const task = requireTask(store, taskId);
  if (task.parent !== null) throw new Error('A subtask moves with its parent');
  if (task.listId === toListId) return;

  const family = store.snapshot().tasks.filter((t) => t.id === taskId || t.parent === taskId);
  await store.commit({
    putTasks: family.map((t) => ({ ...t, listId: toListId })),
    enqueue: [{ kind: 'move', listId: task.listId, taskId, toListId }],
  });
}

export async function deleteTask(store: Store, taskId: string): Promise<void> {
  const task = requireTask(store, taskId);
  const subtasks = store.snapshot().tasks.filter((t) => t.parent === taskId);
  await store.commit({
    removeTasks: [taskId, ...subtasks.map((t) => t.id)],
    removeEntries: [taskId],
    // Google deletes subtasks with their parent, so one op covers them all.
    enqueue: [{ kind: 'delete', listId: task.listId, taskId }],
  });
}
