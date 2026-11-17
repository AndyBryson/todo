import type { Task } from './types';

const isDigits = (s: string) => /^\d+$/.test(s);

// Digit positions compare as numbers ("10" after "9"); anything else, such as the
// empty position of a step Google has not seen yet, sorts after them.
export function comparePosition(a: string, b: string): number {
  const aDigits = isDigits(a);
  const bDigits = isDigits(b);
  if (aDigits && bDigits) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (aDigits !== bDigits) return aDigits ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function subtasksOf(tasks: readonly Task[], parentId: string): Task[] {
  return tasks
    .filter((t) => t.parent === parentId)
    .sort(
      (a, b) => comparePosition(a.position, b.position) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

// Same 20-digit zero-padded format Google uses, so local and pulled positions compare alike.
export function renumber(orderedIds: readonly string[]): Record<string, string> {
  return Object.fromEntries(orderedIds.map((id, i) => [id, String(i).padStart(20, '0')]));
}
