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
