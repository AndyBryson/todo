import type { BoardEntry, Priority } from './types';

// Medium is stored as no field, so an absent priority reads as Medium; so does a
// task with no board entry yet.
export function priorityOf(entry: BoardEntry | undefined): Priority {
  return entry?.priority ?? 'medium';
}
