import { localDate } from './dates';
import { type BoardEntries, COLUMNS, type Task } from './types';

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
  // Pinned cards read in board order: column left to right, then rank.
  const order = (t: Task) => {
    const e = entries[t.id];
    return [e ? COLUMNS.indexOf(e.column) : 0, e?.rank ?? 0] as const;
  };
  sections.pinned.sort((a, b) => {
    const [ca, ra] = order(a);
    const [cb, rb] = order(b);
    return ca - cb || ra - rb;
  });
  return sections;
}
