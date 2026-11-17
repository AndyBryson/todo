import { localDate } from './dates';
import type { BoardEntries, Task } from './types';

export interface TodaySections {
  overdue: Task[];
  dueToday: Task[];
  pinned: Task[];
}

function byDueThenTitle(a: Task, b: Task): number {
  return (a.due ?? '').localeCompare(b.due ?? '') || a.title.localeCompare(b.title);
}

export function todaySections(
  tasks: Task[],
  entries: BoardEntries,
  now: Date,
  timeZone?: string,
): TodaySections {
  const today = localDate(now, timeZone);
  const sections: TodaySections = { overdue: [], dueToday: [], pinned: [] };

  for (const t of tasks) {
    if (t.parent !== null || t.completed) continue;
    // A task is claimed by the first section it fits, so it never shows twice.
    if (t.due !== null && t.due < today) sections.overdue.push(t);
    else if (t.due === today) sections.dueToday.push(t);
    else if (entries[t.id]?.pinned) sections.pinned.push(t);
  }

  sections.overdue.sort(byDueThenTitle);
  sections.dueToday.sort(byDueThenTitle);
  sections.pinned.sort((a, b) => (entries[a.id]?.rank ?? 0) - (entries[b.id]?.rank ?? 0));
  return sections;
}
