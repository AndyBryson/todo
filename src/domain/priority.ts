import type { BoardEntry, Priority } from './types';

// Medium is stored as no field, so an absent priority reads as Medium.
export function priorityOf(entry: BoardEntry): Priority {
  return entry.priority ?? 'medium';
}
