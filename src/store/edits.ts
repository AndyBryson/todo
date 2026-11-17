import { completeEntry, placeInColumn, ranksIn, reopenEntry } from '../domain/board';
import { appendRank } from '../domain/rank';
import { renumber, subtasksOf } from '../domain/subtasks';
import type { BoardEntries, BoardEntry, Column, Task } from '../domain/types';
import type { TaskPatch } from '../google/api';
import type { Change, Snapshot, Store } from './db';

// An edit may still hold a temporary ID that a replay has since renamed.
export function resolveId(s: Snapshot, taskId: string): string {
  let id = taskId;
  const seen = new Set<string>();
  while (Object.hasOwn(s.renamed, id) && !seen.has(id)) {
    seen.add(id);
    id = s.renamed[id] as string;
  }
  return id;
}

function requireTask(s: Snapshot, taskId: string): Task {
  const task = s.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Unknown task ${taskId}`);
  return task;
}

function requireEntry(s: Snapshot, taskId: string): BoardEntry {
  const entry = s.entries[taskId];
  if (!entry) throw new Error(`Task ${taskId} has no board card`);
  return entry;
}

function stamp(changes: BoardEntries, now: string): BoardEntries {
  const stamped: BoardEntries = {};
  for (const [id, e] of Object.entries(changes)) stamped[id] = { ...e, updatedAt: now };
  return stamped;
}

// Every edit reads inside the commit callback, so it sees the latest committed
// state even when another edit is still in flight.

export async function addTask(
  store: Store,
  input: { listId: string; title: string; pinned: boolean },
  now: string,
): Promise<string> {
  const title = input.title.trim();
  if (!title) throw new Error('A task needs a title');

  const id = `local-${crypto.randomUUID()}`;
  await store.commit((s) => ({
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
        rank: appendRank(ranksIn(s.entries, 'Backlog')),
        pinned: input.pinned,
        openColumn: 'Backlog',
        updatedAt: now,
      },
    },
    enqueue: [{ kind: 'create', listId: input.listId, tempId: id, task: { title } }],
    meta: { lastListId: input.listId },
  }));
  return id;
}

export async function editTask(
  store: Store,
  requestedId: string,
  input: Pick<TaskPatch, 'title' | 'notes' | 'due'>,
): Promise<void> {
  await store.commit((s) => {
    const taskId = resolveId(s, requestedId);
    const task = requireTask(s, taskId);
    const set: TaskPatch = {};
    const base: TaskPatch = {};
    for (const key of ['title', 'notes', 'due'] as const) {
      const value = key === 'title' ? input.title?.trim() : input[key];
      if (value === undefined) continue;
      if (key === 'title' && !value) throw new Error('A task needs a title');
      if (value === task[key]) continue;
      (set as Record<string, unknown>)[key] = value;
      (base as Record<string, unknown>)[key] = task[key];
    }
    if (Object.keys(set).length === 0) return {};

    return {
      putTasks: [{ ...task, ...set } as Task],
      enqueue: [{ kind: 'patch', listId: task.listId, taskId, set, base }],
    };
  });
}

function completionChange(s: Snapshot, task: Task, completed: boolean, now: string): Change {
  if (task.completed === completed) return {};
  const entry = s.entries[task.id];
  let changed: BoardEntries | undefined;
  if (entry) {
    if (completed) changed = { [task.id]: completeEntry(entry, now) };
    else if (entry.column === 'Done') changed = { [task.id]: reopenEntry(entry, s.entries, now) };
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
  requestedId: string,
  completed: boolean,
  now: string,
): Promise<void> {
  await store.commit((s) =>
    completionChange(s, requireTask(s, resolveId(s, requestedId)), completed, now),
  );
}

function moveChange(
  s: Snapshot,
  taskId: string,
  column: Column,
  insertAfter: string | null,
  now: string,
): Change {
  const task = requireTask(s, taskId);
  const entry = requireEntry(s, taskId);

  if (column === 'Done') {
    return entry.column === 'Done' ? {} : completionChange(s, task, true, now);
  }

  // Reopen and placement go in one commit so the card never shows in its old column.
  const reopen = entry.column === 'Done' ? completionChange(s, task, false, now) : {};
  const entries = { ...s.entries, ...reopen.entries };
  const placed = stamp(placeInColumn(entries, taskId, column, insertAfter), now);
  return { ...reopen, entries: { ...reopen.entries, ...placed } };
}

export async function moveCard(
  store: Store,
  requestedId: string,
  column: Column,
  requestedAfter: string | null,
  now: string,
): Promise<void> {
  await store.commit((s) =>
    moveChange(
      s,
      resolveId(s, requestedId),
      column,
      requestedAfter === null ? null : resolveId(s, requestedAfter),
      now,
    ),
  );
}

// The bottom is found inside the commit, so a stale view cannot drop the card at the top.
export async function moveCardToBottom(
  store: Store,
  requestedId: string,
  column: Column,
  now: string,
): Promise<void> {
  await store.commit((s) => {
    const taskId = resolveId(s, requestedId);
    const last = Object.entries(s.entries)
      .filter(([id, e]) => id !== taskId && e.column === column)
      .sort(([, a], [, b]) => a.rank - b.rank)
      .at(-1);
    // Already the bottom card: re-ranking would only bump updatedAt and win a board merge for nothing.
    const entry = s.entries[taskId];
    if (entry?.column === column && (!last || last[1].rank < entry.rank)) return {};
    return moveChange(s, taskId, column, last?.[0] ?? null, now);
  });
}

export async function setPinned(
  store: Store,
  requestedId: string,
  pinned: boolean,
  now: string,
): Promise<void> {
  await store.commit((s) => {
    const taskId = resolveId(s, requestedId);
    requireTask(s, taskId);
    const entry = requireEntry(s, taskId);
    return { entries: { [taskId]: { ...entry, pinned, updatedAt: now } } };
  });
}

export async function moveToList(
  store: Store,
  requestedId: string,
  toListId: string,
): Promise<void> {
  await store.commit((s) => {
    const taskId = resolveId(s, requestedId);
    const task = requireTask(s, taskId);
    if (task.parent !== null) throw new Error('A subtask moves with its parent');
    if (task.listId === toListId) return {};

    const family = s.tasks.filter((t) => t.id === taskId || t.parent === taskId);
    return {
      putTasks: family.map((t) => ({ ...t, listId: toListId })),
      enqueue: [{ kind: 'move', listId: task.listId, taskId, toListId }],
    };
  });
}

export async function deleteTask(store: Store, requestedId: string): Promise<void> {
  await store.commit((s) => {
    const taskId = resolveId(s, requestedId);
    const task = requireTask(s, taskId);
    const subtasks = s.tasks.filter((t) => t.parent === taskId);
    return {
      removeTasks: [taskId, ...subtasks.map((t) => t.id)],
      removeEntries: [taskId],
      // Google deletes subtasks with their parent, so one op covers them all.
      enqueue: [{ kind: 'delete', listId: task.listId, taskId }],
    };
  });
}

// Positions are renumbered locally in the same commit as the op, so the new order
// shows at once and never depends on Google answering first.
export async function addSubtask(
  store: Store,
  requestedParentId: string,
  title: string,
  now: string,
): Promise<string> {
  const trimmed = title.trim();
  if (!trimmed) throw new Error('A step needs a title');

  const id = `local-${crypto.randomUUID()}`;
  await store.commit((s) => {
    const parent = requireTask(s, resolveId(s, requestedParentId));
    if (parent.parent !== null) throw new Error('A step cannot have steps of its own');

    const siblings = subtasksOf(s.tasks, parent.id);
    const positions = renumber([...siblings.map((t) => t.id), id]);
    return {
      putTasks: [
        ...siblings.map((t) => ({ ...t, position: positions[t.id] as string })),
        {
          id,
          listId: parent.listId,
          title: trimmed,
          notes: '',
          due: null,
          completed: false,
          completedAt: null,
          parent: parent.id,
          position: positions[id] as string,
          updated: now,
        },
      ],
      enqueue: [
        {
          kind: 'create',
          listId: parent.listId,
          tempId: id,
          // Google inserts first unless told otherwise, so name the current last step.
          task: {
            title: trimmed,
            parent: parent.id,
            ...(siblings.length > 0 && { previous: siblings[siblings.length - 1]?.id }),
          },
        },
      ],
    };
  });
  return id;
}

export async function reorderSubtask(
  store: Store,
  requestedId: string,
  requestedPreviousId: string | null,
  now: string,
): Promise<void> {
  await store.commit((s) => {
    const taskId = resolveId(s, requestedId);
    const previousId = requestedPreviousId === null ? null : resolveId(s, requestedPreviousId);
    const task = requireTask(s, taskId);
    const parentId = task.parent;
    if (parentId === null) throw new Error('Only a step can be reordered');

    const current = subtasksOf(s.tasks, parentId).map((t) => t.id);
    if (previousId !== null && (previousId === taskId || !current.includes(previousId))) {
      throw new Error(`${requestedPreviousId} is not a step beside ${requestedId}`);
    }

    const others = current.filter((id) => id !== taskId);
    const at = previousId === null ? 0 : others.indexOf(previousId) + 1;
    const next = [...others.slice(0, at), taskId, ...others.slice(at)];
    if (next.every((id, i) => id === current[i])) return {};

    const positions = renumber(next);
    return {
      putTasks: s.tasks
        .filter((t) => t.parent === parentId)
        .map((t) => ({
          ...t,
          position: positions[t.id] as string,
          ...(t.id === taskId && { updated: now }),
        })),
      enqueue: [
        {
          kind: 'reorder',
          listId: task.listId,
          taskId,
          parent: parentId,
          previous: previousId,
        },
      ],
    };
  });
}
