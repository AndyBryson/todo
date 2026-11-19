import { completeEntry, placeInColumn, ranksIn, reopenEntry } from '../domain/board';
import { priorityOf } from '../domain/priority';
import { appendRank } from '../domain/rank';
import { renumber, subtasksOf } from '../domain/subtasks';
import {
  type BoardEntries,
  type BoardEntry,
  COLUMNS,
  type Column,
  type Priority,
  type Task,
} from '../domain/types';
import type { NewTask, TaskPatch } from '../google/api';
import type { Change, Fingerprint, Op, Snapshot, Store } from './db';

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

// Splits board changes into this store's and those for cards owned by other accounts.
function split(s: Snapshot, changes: BoardEntries): { own: BoardEntries; foreign: BoardEntries } {
  const own: BoardEntries = {};
  const foreign: BoardEntries = {};
  for (const [id, e] of Object.entries(changes)) {
    if (Object.hasOwn(s.entries, id)) own[id] = e;
    else foreign[id] = e;
  }
  return { own, foreign };
}

// Every edit reads inside the commit callback, so it sees the latest committed
// state even when another edit is still in flight.
//
// `others` holds the other accounts' board entries. Cards from every account share a
// column, so ranks and the bottom of a column are worked out over all of them.

export async function addTask(
  store: Store,
  input: { listId: string; title: string; pinned: boolean },
  now: string,
  others: BoardEntries = {},
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
        rank: appendRank(ranksIn({ ...others, ...s.entries }, 'Backlog')),
        pinned: input.pinned,
        openColumn: 'Backlog',
        updatedAt: now,
      },
    },
    enqueue: [{ kind: 'create', listId: input.listId, tempId: id, task: { title } }],
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

function completionChange(
  s: Snapshot,
  task: Task,
  completed: boolean,
  now: string,
  others: BoardEntries,
): Change {
  if (task.completed === completed) return {};
  const entry = s.entries[task.id];
  let changed: BoardEntries | undefined;
  if (entry) {
    if (completed) changed = { [task.id]: completeEntry(entry, now) };
    else if (entry.column === 'Done') {
      changed = { [task.id]: reopenEntry(entry, { ...others, ...s.entries }, now) };
    }
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
  others: BoardEntries = {},
): Promise<void> {
  await store.commit((s) =>
    completionChange(s, requireTask(s, resolveId(s, requestedId)), completed, now, others),
  );
}

interface Moved {
  change: Change;
  // Rebalanced ranks for other accounts' cards, already stamped.
  foreign: BoardEntries;
}

function moveChange(
  s: Snapshot,
  taskId: string,
  column: Column,
  insertAfter: string | null,
  now: string,
  others: BoardEntries,
): Moved {
  const task = requireTask(s, taskId);
  const entry = requireEntry(s, taskId);

  if (column === 'Done') {
    return {
      change: entry.column === 'Done' ? {} : completionChange(s, task, true, now, others),
      foreign: {},
    };
  }

  // Reopen and placement go in one commit so the card never shows in its old column.
  const reopen = entry.column === 'Done' ? completionChange(s, task, false, now, others) : {};
  const entries = { ...others, ...s.entries, ...reopen.entries };
  const { own, foreign } = split(
    s,
    stamp(placeInColumn(entries, taskId, column, insertAfter), now),
  );
  return { change: { ...reopen, entries: { ...reopen.entries, ...own } }, foreign };
}

export async function moveCard(
  store: Store,
  requestedId: string,
  column: Column,
  requestedAfter: string | null,
  now: string,
  others: BoardEntries = {},
): Promise<BoardEntries> {
  let foreign: BoardEntries = {};
  await store.commit((s) => {
    foreign = {};
    const moved = moveChange(
      s,
      resolveId(s, requestedId),
      column,
      requestedAfter === null ? null : resolveId(s, requestedAfter),
      now,
      others,
    );
    foreign = moved.foreign;
    return moved.change;
  });
  return foreign;
}

// The bottom is found inside the commit, so a stale view cannot drop the card at the top.
export async function moveCardToBottom(
  store: Store,
  requestedId: string,
  column: Column,
  now: string,
  others: BoardEntries = {},
): Promise<BoardEntries> {
  let foreign: BoardEntries = {};
  await store.commit((s) => {
    foreign = {};
    const taskId = resolveId(s, requestedId);
    const last = Object.entries({ ...others, ...s.entries })
      .filter(([id, e]) => id !== taskId && e.column === column)
      .sort(([, a], [, b]) => a.rank - b.rank)
      .at(-1);
    // Already the bottom card: re-ranking would only bump updatedAt and win a board merge for nothing.
    const entry = s.entries[taskId];
    if (entry?.column === column && (!last || last[1].rank < entry.rank)) return {};
    const moved = moveChange(s, taskId, column, last?.[0] ?? null, now, others);
    foreign = moved.foreign;
    return moved.change;
  });
  return foreign;
}

// The order the board shows: by rank in open columns, newest first in Done, where a
// rank is only what the card had in the column it came from.
export function boardOrder(
  a: { entry: BoardEntry; task: Task },
  b: { entry: BoardEntry; task: Task },
): number {
  return (
    COLUMNS.indexOf(a.entry.column) - COLUMNS.indexOf(b.entry.column) ||
    (a.entry.column === 'Done'
      ? (b.task.completedAt ?? '').localeCompare(a.task.completedAt ?? '')
      : a.entry.rank - b.entry.rank)
  );
}

// One save for the whole selection: each card's change is built on the state the
// previous card left, so ranks and Done rules match moving them one by one.
export async function moveCardsToBottom(
  store: Store,
  requestedIds: readonly string[],
  column: Column,
  now: string,
  others: BoardEntries = {},
): Promise<BoardEntries> {
  let foreign: BoardEntries = {};
  await store.commit((s) => {
    foreign = {};
    const ids = [...new Set(requestedIds.map((id) => resolveId(s, id)))];
    const moving = ids
      .flatMap((id) => {
        const entry = s.entries[id];
        const task = s.tasks.find((t) => t.id === id);
        return entry && task && entry.column !== column ? [{ id, entry, task }] : [];
      })
      .sort(boardOrder);

    let working = s;
    const merged: Required<Pick<Change, 'putTasks' | 'entries' | 'enqueue'>> = {
      putTasks: [],
      entries: {},
      enqueue: [],
    };
    let workingOthers = others;
    let after = column === 'Done' ? null : (bottomOf({ ...others, ...s.entries }, column) ?? null);
    for (const { id } of moving) {
      const moved = moveChange(working, id, column, after, now, workingOthers);
      const change = moved.change;
      workingOthers = { ...workingOthers, ...moved.foreign };
      foreign = { ...foreign, ...moved.foreign };
      const put = change.putTasks ?? [];
      working = {
        ...working,
        tasks: working.tasks.map((t) => put.find((p) => p.id === t.id) ?? t),
        entries: { ...working.entries, ...change.entries },
      };
      merged.putTasks = [...merged.putTasks.filter((t) => !put.some((p) => p.id === t.id)), ...put];
      merged.entries = { ...merged.entries, ...change.entries };
      merged.enqueue = [...merged.enqueue, ...(change.enqueue ?? [])];
      after = id;
    }
    return moving.length === 0 ? {} : merged;
  });
  return foreign;
}

function bottomOf(entries: BoardEntries, column: Column): string | undefined {
  return Object.entries(entries)
    .filter(([, e]) => e.column === column)
    .sort(([, a], [, b]) => a.rank - b.rank)
    .at(-1)?.[0];
}

// For the rebalanced ranks a move hands back: each store takes only its own cards.
// The entries were read before this commit, so only the rank is taken from them: a
// priority, column or unknown field changed since must not be reverted.
export async function putEntries(store: Store, entries: BoardEntries): Promise<void> {
  await store.commit((s) => {
    const own: BoardEntries = {};
    for (const [id, e] of Object.entries(split(s, entries).own)) {
      own[id] = { ...(s.entries[id] as BoardEntry), rank: e.rank, updatedAt: e.updatedAt };
    }
    return Object.keys(own).length === 0 ? {} : { entries: own };
  });
}

function opNamesTask(op: Op, ids: ReadonlySet<string>, parentId: string): boolean {
  switch (op.kind) {
    case 'create':
      return ids.has(op.tempId) || op.task.parent === parentId;
    case 'reorder':
      return ids.has(op.taskId) || op.parent === parentId;
    default:
      return ids.has(op.taskId);
  }
}

// A copy is built from the mirror, so anything still waiting to reach Google would be
// lost from the copy and then deleted with the original.
export function hasUnsent(s: Snapshot, taskId: string): boolean {
  const ids = new Set([taskId, ...s.tasks.filter((t) => t.parent === taskId).map((t) => t.id)]);
  return s.queued.some((q) => opNamesTask(q.op, ids, taskId));
}

// Moves between accounts are a copy in the target and, once that copy is safely made,
// a checked delete of the original. Until then the original is only hidden.
export async function copyToAccount(
  source: Store,
  target: Store,
  sourceAccountId: string,
  targetAccountId: string,
  requestedId: string,
  toListId: string,
  now: string,
): Promise<void> {
  let taskId = requestedId;
  await target.commit(() => {
    const s = source.snapshot();
    taskId = resolveId(s, requestedId);
    const original = requireTask(s, taskId);
    if (original.parent !== null) throw new Error('A step moves with its parent');
    if (hasUnsent(s, taskId)) throw new Error('This task has changes still waiting to be sent');

    const steps = subtasksOf(s.tasks, taskId);
    const copyId = `local-${crypto.randomUUID()}`;
    const stepIds = steps.map(() => `local-${crypto.randomUUID()}`);
    // Local positions keep the steps in order until the next pull brings Google's.
    const positions = renumber(stepIds);

    const copyOf = (t: Task, id: string, parent: string | null, position: string): Task => ({
      ...t,
      id,
      listId: toListId,
      parent,
      position,
      updated: now,
    });
    // NewTask cannot carry completion, so a done item is created open and then completed.
    const opsFor = (t: Task, id: string, extra: Partial<NewTask>): Op[] => [
      {
        kind: 'create',
        listId: toListId,
        tempId: id,
        task: {
          title: t.title,
          ...(t.notes && { notes: t.notes }),
          ...(t.due && { due: t.due }),
          ...extra,
        },
      },
      ...(t.completed
        ? [
            {
              kind: 'patch',
              listId: toListId,
              taskId: id,
              set: { completed: true },
              base: { completed: false },
            } satisfies Op,
          ]
        : []),
    ];

    const fingerprint: Fingerprint = {
      updated: original.updated,
      steps: Object.fromEntries(steps.map((t) => [t.id, t.updated])),
    };
    const entry = s.entries[taskId];
    return {
      putTasks: [
        copyOf(original, copyId, null, ''),
        ...steps.map((t, i) =>
          copyOf(t, stepIds[i] as string, copyId, positions[stepIds[i] as string] as string),
        ),
      ],
      entries: entry ? { [copyId]: { ...entry, updatedAt: now } } : undefined,
      enqueue: [
        ...opsFor(original, copyId, {}),
        ...steps.flatMap((t, i) =>
          opsFor(t, stepIds[i] as string, {
            parent: copyId,
            // Google inserts first unless told otherwise, so name the step copied before.
            ...(i > 0 && { previous: stepIds[i - 1] as string }),
          }),
        ),
        {
          kind: 'handoff',
          listId: toListId,
          taskId: copyId,
          source: {
            accountId: sourceAccountId,
            listId: original.listId,
            taskId,
            title: original.title,
          },
          fingerprint,
        },
      ],
    };
  });
  await source.commit((s) => ({ meta: { hidden: { ...s.hidden, [taskId]: targetAccountId } } }));
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

export async function setPriority(
  store: Store,
  requestedId: string,
  priority: Priority,
  now: string,
): Promise<void> {
  await store.commit((s) => {
    const taskId = resolveId(s, requestedId);
    requireTask(s, taskId);
    const entry = requireEntry(s, taskId);
    if (priorityOf(entry) === priority) return {};
    // Medium is stored as no field, so the key is dropped rather than set.
    const { priority: _old, ...rest } = entry;
    const next: BoardEntry =
      priority === 'medium' ? { ...rest, updatedAt: now } : { ...rest, priority, updatedAt: now };
    return { entries: { [taskId]: next } };
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

// Whitespace only stores an empty name, which means "use the Google name" and still syncs.
export async function renameAccount(store: Store, name: string, now: string): Promise<void> {
  await store.commit({ meta: { accountName: { name: name.trim(), updatedAt: now } } });
}
