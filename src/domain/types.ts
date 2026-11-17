export const COLUMNS = ['Backlog', 'Next', 'Doing', 'Waiting', 'Done'] as const;
export type Column = (typeof COLUMNS)[number];
export type OpenColumn = Exclude<Column, 'Done'>;
export type LocalDate = string; // YYYY-MM-DD

export interface TaskList {
  id: string;
  title: string;
}

export interface Task {
  id: string;
  listId: string;
  title: string;
  notes: string;
  due: LocalDate | null;
  completed: boolean;
  completedAt: string | null; // ISO instant
  parent: string | null;
  position: string;
  updated: string;
}

export const PRIORITIES = ['highest', 'high', 'medium', 'low', 'lowest'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface BoardEntry {
  column: Column;
  rank: number;
  pinned: boolean;
  openColumn: OpenColumn;
  updatedAt: string;
  // Medium is stored as no field, so boards that never use priority are unchanged.
  priority?: Exclude<Priority, 'medium'>;
  // Fields this version does not recognise, kept so an older device never strips a newer one's data.
  extra?: Record<string, unknown>;
}

export type BoardEntries = Record<string, BoardEntry>;

export interface BoardFile {
  version: 1;
  entries: BoardEntries;
}
