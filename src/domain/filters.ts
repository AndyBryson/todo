import { addDays } from './dates';
import { priorityOf } from './priority';
import type { BoardEntry, LocalDate, Priority, Task } from './types';
import { PRIORITIES } from './types';

export interface BoardFilters {
  lists: ReadonlySet<string> | null;
  priorities: ReadonlySet<Priority>;
  planned: { on: boolean; days: number };
}

export const DEFAULT_FILTERS: BoardFilters = {
  lists: null,
  priorities: new Set(PRIORITIES),
  planned: { on: false, days: 14 },
};

// The part of the filters that applies on Today as well as the board.
export function listAndPriorityVisible(
  task: Task,
  entry: BoardEntry | undefined,
  filters: BoardFilters,
): boolean {
  if (filters.lists && !filters.lists.has(task.listId)) return false;
  return filters.priorities.has(priorityOf(entry));
}

export function cardVisible(
  task: Task,
  entry: BoardEntry,
  filters: BoardFilters,
  today: LocalDate,
): boolean {
  if (!listAndPriorityVisible(task, entry, filters)) return false;
  // Done work is history, not a plan, so a planned-date cut-off never hides it.
  if (!filters.planned.on || entry.column === 'Done' || !task.due) return true;
  return task.due <= addDays(today, filters.planned.days);
}

export function activeFilterCount(filters: BoardFilters): number {
  const prioritiesNarrowed = PRIORITIES.some((p) => !filters.priorities.has(p));
  return (prioritiesNarrowed ? 1 : 0) + (filters.planned.on ? 1 : 0);
}

// null means every list is shown, so every box reads as ticked. Unticking the
// only ticked list returns to null rather than showing nothing.
export function toggleListFilter(
  current: ReadonlySet<string> | null,
  id: string,
  allIds: readonly string[],
): ReadonlySet<string> | null {
  const next = new Set(current ?? allIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next.size === 0 || next.size === allIds.length ? null : next;
}

// Lists can disappear after a sync or a sign-out, and a stale selection must not
// hide every card. A selection that covers every list is the same as no filter,
// so it reads as null and Show all does not appear with every box ticked.
export function effectiveListFilter(
  filter: ReadonlySet<string> | null,
  listIds: readonly string[],
): ReadonlySet<string> | null {
  if (!filter) return null;
  const kept = new Set(listIds.filter((id) => filter.has(id)));
  return kept.size === 0 || kept.size === listIds.length ? null : kept;
}

// Clicking the list that is already shown alone is the way back to every list.
// Stale IDs from deleted lists are ignored, or they would block that way back.
export function showOnlyList(
  current: ReadonlySet<string> | null,
  id: string,
  allIds: readonly string[],
): ReadonlySet<string> | null {
  const alone = current !== null && allIds.every((other) => current.has(other) === (other === id));
  return alone || allIds.length <= 1 ? null : new Set([id]);
}

// A newly added account's lists only arrive with its first pull, so an active list
// filter waits for them; otherwise the account would look empty.
export function showNewAccounts(
  filter: ReadonlySet<string> | null,
  waiting: ReadonlySet<string>,
  listAccount: Readonly<Record<string, string>>,
): { filter: Set<string> | null; waiting: Set<string> } | null {
  const arrived = new Set(Object.values(listAccount).filter((id) => waiting.has(id)));
  if (arrived.size === 0) return null;
  const listIds = Object.keys(listAccount).filter((id) => arrived.has(listAccount[id] ?? ''));
  return {
    filter: filter ? new Set([...filter, ...listIds]) : null,
    waiting: new Set([...waiting].filter((id) => !arrived.has(id))),
  };
}
