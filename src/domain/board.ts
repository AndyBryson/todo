import { appendRank } from './rank';
import {
  type BoardEntries,
  type BoardEntry,
  type BoardFile,
  COLUMNS,
  type Column,
  type OpenColumn,
  type Task,
  type TaskList,
} from './types';

function isColumn(value: unknown): value is Column {
  return COLUMNS.includes(value as Column);
}

function isOpenColumn(value: unknown): value is OpenColumn {
  return isColumn(value) && value !== 'Done';
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
  return {
    column: e.column,
    rank: e.rank,
    pinned: e.pinned,
    openColumn: e.openColumn,
    updatedAt: e.updatedAt,
  };
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
  const file: BoardFile = { version: 1, entries };
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

function ranksIn(entries: BoardEntries, column: Column): number[] {
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

// Google positions are digit strings, so "10" must sort after "9".
function comparePosition(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
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
