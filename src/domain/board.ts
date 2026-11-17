import { localDate } from './dates';
import { type BoardFilters, cardVisible } from './filters';
import { appendRank, placeCard } from './rank';
import { comparePosition } from './subtasks';
import {
  type BoardEntries,
  type BoardEntry,
  type BoardFile,
  COLUMNS,
  type Column,
  type OpenColumn,
  PRIORITIES,
  type Priority,
  type Task,
  type TaskList,
} from './types';

function isColumn(value: unknown): value is Column {
  return COLUMNS.includes(value as Column);
}

function isOpenColumn(value: unknown): value is OpenColumn {
  return isColumn(value) && value !== 'Done';
}

const KNOWN_FIELDS = new Set(['column', 'rank', 'pinned', 'openColumn', 'updatedAt', 'priority']);

function isStoredPriority(value: unknown): value is NonNullable<BoardEntry['priority']> {
  return value !== 'medium' && PRIORITIES.includes(value as Priority);
}

function parseEntry(value: unknown): BoardEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const e = value as Record<string, unknown>;
  if (
    !isColumn(e.column) ||
    typeof e.rank !== 'number' ||
    !Number.isFinite(e.rank) ||
    typeof e.pinned !== 'boolean' ||
    !isOpenColumn(e.openColumn) ||
    typeof e.updatedAt !== 'string' ||
    Number.isNaN(Date.parse(e.updatedAt))
  ) {
    return null;
  }
  const parsed: BoardEntry = {
    column: e.column,
    rank: e.rank,
    pinned: e.pinned,
    openColumn: e.openColumn,
    updatedAt: e.updatedAt,
  };
  // A bad priority reads as Medium rather than rejecting the entry and losing its column.
  if (isStoredPriority(e.priority)) parsed.priority = e.priority;
  const extra = Object.fromEntries(Object.entries(e).filter(([key]) => !KNOWN_FIELDS.has(key)));
  if (Object.keys(extra).length > 0) parsed.extra = extra;
  return parsed;
}

// A damaged board.json must never block the app: bad data reads as "no
// metadata" and reconcile rebuilds it from the tasks.
export function parseBoardFile(raw: string | null): BoardEntries {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof data !== 'object' || data === null) return {};
  const file = data as Record<string, unknown>;
  if (file.version !== 1 || typeof file.entries !== 'object' || file.entries === null) return {};

  const entries: BoardEntries = {};
  for (const [id, value] of Object.entries(file.entries)) {
    const parsed = parseEntry(value);
    if (parsed) entries[id] = parsed;
  }
  return entries;
}

export function serialiseBoard(entries: BoardEntries): string {
  // Sorted so identical entries always serialise identically; otherwise devices
  // holding the same data in a different key order would keep rewriting the file.
  const sorted: BoardEntries = {};
  for (const id of Object.keys(entries).sort()) {
    const e = entries[id] as BoardEntry;
    const written: Record<string, unknown> = {
      column: e.column,
      rank: e.rank,
      pinned: e.pinned,
      openColumn: e.openColumn,
      updatedAt: e.updatedAt,
    };
    if (e.priority) written.priority = e.priority;
    for (const key of Object.keys(e.extra ?? {}).sort()) {
      if (!KNOWN_FIELDS.has(key)) written[key] = e.extra?.[key];
    }
    sorted[id] = written as unknown as BoardEntry;
  }
  const file: BoardFile = { version: 1, entries: sorted };
  return JSON.stringify(file);
}

export function mergeEntries(local: BoardEntries, remote: BoardEntries): BoardEntries {
  const merged: BoardEntries = { ...local };
  for (const [id, theirs] of Object.entries(remote)) {
    const ours = merged[id];
    // Compare instants, not strings: offsets and fractional seconds break text order.
    // Equal instants keep remote so every device settles on the same entry.
    if (!ours || Date.parse(theirs.updatedAt) >= Date.parse(ours.updatedAt)) merged[id] = theirs;
  }
  return merged;
}

export function completeEntry(entry: BoardEntry, now: string): BoardEntry {
  return {
    ...entry,
    column: 'Done',
    openColumn: entry.column === 'Done' ? entry.openColumn : entry.column,
    pinned: false,
    updatedAt: now,
  };
}

export function ranksIn(entries: BoardEntries, column: Column): number[] {
  return Object.values(entries)
    .filter((e) => e.column === column)
    .map((e) => e.rank);
}

export function reopenEntry(entry: BoardEntry, entries: BoardEntries, now: string): BoardEntry {
  return {
    ...entry,
    column: entry.openColumn,
    rank: appendRank(ranksIn(entries, entry.openColumn)),
    updatedAt: now,
  };
}

function inGoogleOrder(tasks: Task[], lists: TaskList[]): Task[] {
  const listIndex = (id: string) => {
    const i = lists.findIndex((l) => l.id === id);
    return i === -1 ? lists.length : i;
  };
  return tasks
    .filter((t) => t.parent === null)
    .sort(
      (a, b) =>
        listIndex(a.listId) - listIndex(b.listId) || comparePosition(a.position, b.position),
    );
}

export function reconcile(
  tasks: Task[],
  lists: TaskList[],
  entries: BoardEntries,
  now: string,
): BoardEntries {
  const result: BoardEntries = {};
  const ordered = inGoogleOrder(tasks, lists);
  const live = new Set(ordered.map((t) => t.id));
  for (const [id, entry] of Object.entries(entries)) {
    if (live.has(id)) result[id] = entry;
  }

  for (const t of ordered) {
    const existing = result[t.id];
    if (!existing) {
      const fresh: BoardEntry = {
        column: 'Backlog',
        rank: appendRank(ranksIn(result, 'Backlog')),
        pinned: false,
        openColumn: 'Backlog',
        updatedAt: now,
      };
      result[t.id] = t.completed ? completeEntry(fresh, now) : fresh;
    } else if (t.completed && existing.column !== 'Done') {
      result[t.id] = completeEntry(existing, now);
    } else if (!t.completed && existing.column === 'Done') {
      result[t.id] = reopenEntry(existing, result, now);
    }
  }
  return result;
}

export interface Card {
  task: Task;
  list: TaskList;
  entry: BoardEntry;
  colour: string;
  steps: { done: number; total: number } | null;
}

// Done shows, and pull fetches, top-level tasks completed within this window.
export const DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Chosen to stay legible on both light and dark backgrounds.
const PALETTE = [
  '#e5484d',
  '#f76b15',
  '#d6a100',
  '#30a46c',
  '#12a594',
  '#0090ff',
  '#6e56cf',
  '#d6409f',
] as const;

// FNV-1a, 32-bit. A hash rather than list order, so a list keeps its colour when others are added.
export function listColour(listId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < listId.length; i++) {
    hash ^= listId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PALETTE[hash % PALETTE.length] as string;
}

export function buildBoard(
  tasks: Task[],
  lists: TaskList[],
  entries: BoardEntries,
  filters: BoardFilters,
  now: Date,
): Record<Column, Card[]> {
  const board: Record<Column, Card[]> = {
    Backlog: [],
    Next: [],
    Doing: [],
    Waiting: [],
    Done: [],
  };
  const today = localDate(now);
  const doneSince = now.getTime() - DONE_WINDOW_MS;
  const stepCounts = new Map<string, { done: number; total: number }>();
  for (const t of tasks) {
    if (t.parent === null) continue;
    const counts = stepCounts.get(t.parent) ?? { done: 0, total: 0 };
    counts.total += 1;
    if (t.completed) counts.done += 1;
    stepCounts.set(t.parent, counts);
  }

  for (const t of tasks) {
    const e = entries[t.id];
    const list = lists.find((l) => l.id === t.listId);
    if (t.parent !== null || !e || !list) continue;
    if (!cardVisible(t, e, filters, today)) continue;
    if (e.column === 'Done' && Date.parse(t.completedAt ?? '') < doneSince) continue;
    board[e.column].push({
      task: t,
      list,
      entry: e,
      colour: listColour(t.listId),
      steps: stepCounts.get(t.id) ?? null,
    });
  }

  for (const column of COLUMNS) {
    if (column === 'Done') {
      board.Done.sort(
        (a, b) => Date.parse(b.task.completedAt ?? '') - Date.parse(a.task.completedAt ?? ''),
      );
    } else {
      board[column].sort((a, b) => a.entry.rank - b.entry.rank);
    }
  }
  return board;
}

// Ranks are computed over the whole column, hidden lists included, so a filtered
// drop never reshuffles cards the user cannot see.
export function placeInColumn(
  entries: BoardEntries,
  taskId: string,
  column: OpenColumn,
  insertAfter: string | null,
): BoardEntries {
  const moved = entries[taskId];
  if (!moved) return {};

  const ids = Object.keys(entries)
    .filter((id) => id !== taskId && entries[id]?.column === column)
    .sort((a, b) => (entries[a]?.rank ?? 0) - (entries[b]?.rank ?? 0));
  const after = insertAfter === null ? -1 : ids.indexOf(insertAfter);
  const { rank, rebalanced } = placeCard(
    ids.map((id) => entries[id]?.rank ?? 0),
    after + 1,
  );

  const changes: BoardEntries = {
    [taskId]: { ...moved, column, openColumn: column, rank },
  };
  if (rebalanced) {
    ids.forEach((id, i) => {
      const e = entries[id];
      if (e) changes[id] = { ...e, rank: rebalanced[i] as number };
    });
  }
  return changes;
}
