import type { LocalDate, Task, TaskList } from '../domain/types';

export interface NewTask {
  title: string;
  notes?: string;
  due?: LocalDate | null;
  parent?: string;
  // Previous sibling; Google puts a task with none first.
  previous?: string;
}

export type TaskPatch = Partial<{
  title: string;
  notes: string;
  due: LocalDate | null;
  completed: boolean;
}>;

export interface GoogleApi {
  listTaskLists(): Promise<TaskList[]>;
  // The list Google Home and other Google clients add to (My Tasks).
  getDefaultListId(): Promise<string>;
  insertTaskList(title: string): Promise<TaskList>;
  patchTaskList(listId: string, title: string): Promise<TaskList>;
  // Google also deletes every task in the list. It refuses the default list.
  deleteTaskList(listId: string): Promise<void>;
  // Open tasks, top-level tasks completed since completedSince, and completed subtasks of any
  // age so a card's step count stays right; hidden included; every page.
  listTasks(listId: string, completedSince: string): Promise<Task[]>;
  getTask(listId: string, taskId: string): Promise<Task>;
  insertTask(listId: string, task: NewTask): Promise<Task>;
  patchTask(listId: string, taskId: string, patch: TaskPatch): Promise<Task>;
  deleteTask(listId: string, taskId: string): Promise<void>;
  moveTask(listId: string, taskId: string, destinationListId: string): Promise<Task>;
  // Places the task under parent directly after previous (first when null).
  reorderTask(
    listId: string,
    taskId: string,
    parent: string,
    previous: string | null,
  ): Promise<Task>;
  readBoard(): Promise<{ raw: string | null; version: string | null }>;
  writeBoard(raw: string, expectedVersion: string | null): Promise<'ok' | 'conflict'>;
}

/** 401, or no token obtainable. */
export class AuthError extends Error {}
/** fetch threw, or the browser reports it is offline. */
export class OfflineError extends Error {}
/** 404 or 410. */
export class NotFoundError extends Error {}
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
