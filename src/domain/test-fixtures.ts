import type { BoardEntry, Task } from './types';

export const OLD = '2026-11-01T00:00:00Z';

export function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    listId: 'L1',
    title: id,
    notes: '',
    due: null,
    completed: false,
    completedAt: null,
    parent: null,
    position: '0',
    updated: OLD,
    ...overrides,
  };
}

export function entry(overrides: Partial<BoardEntry> = {}): BoardEntry {
  return {
    column: 'Backlog',
    rank: 1024,
    pinned: false,
    openColumn: 'Backlog',
    updatedAt: OLD,
    ...overrides,
  };
}
