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

export interface BoardEntry {
  column: Column;
  rank: number;
  pinned: boolean;
  openColumn: OpenColumn;
  updatedAt: string;
}

export type BoardEntries = Record<string, BoardEntry>;

export interface BoardFile {
  version: 1;
  entries: BoardEntries;
}
