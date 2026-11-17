import { priorityOf } from './board';
import { addDays } from './dates';
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

export function cardVisible(
  task: Task,
  entry: BoardEntry,
  filters: BoardFilters,
  today: LocalDate,
): boolean {
  if (filters.lists && !filters.lists.has(task.listId)) return false;
  if (!filters.priorities.has(priorityOf(entry))) return false;
  // Done work is history, not a plan, so a planned-date cut-off never hides it.
  if (!filters.planned.on || entry.column === 'Done' || !task.due) return true;
  return task.due <= addDays(today, filters.planned.days);
}

export function activeFilterCount(filters: BoardFilters): number {
  const prioritiesNarrowed = PRIORITIES.some((p) => !filters.priorities.has(p));
  return (prioritiesNarrowed ? 1 : 0) + (filters.planned.on ? 1 : 0);
}
