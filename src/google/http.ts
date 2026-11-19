import { fromGoogleDue, toGoogleDue } from '../domain/dates';
import type { Task, TaskList } from '../domain/types';
import {
  AuthError,
  type GoogleApi,
  HttpError,
  type NewTask,
  NotFoundError,
  OfflineError,
  type TaskPatch,
} from './api';

// Checked against live Google on 2026-11-17: tasks.move keeps the task ID and takes subtasks
// with it; every Drive upload bumps the file version; insert without `previous` puts the task
// first; insert or move naming a deleted `previous` is a 404 ("Previous task id not found");
// deleting a parent deletes its subtasks (they read back as deleted: true).
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_ABOUT = 'https://www.googleapis.com/drive/v3/about';
const BOARD_NAME = 'board.json';

interface GoogleTask {
  id: string;
  title?: string;
  notes?: string;
  status?: string;
  due?: string;
  completed?: string;
  parent?: string;
  position?: string;
  updated?: string;
  deleted?: boolean;
}

interface Page<T> {
  items?: T[];
  nextPageToken?: string;
}

interface DriveFile {
  id: string;
  version?: string | number;
}

function toTask(listId: string, g: GoogleTask): Task {
  return {
    id: g.id,
    listId,
    title: g.title ?? '',
    notes: g.notes ?? '',
    due: fromGoogleDue(g.due),
    completed: g.status === 'completed',
    completedAt: g.completed ?? null,
    parent: g.parent ?? null,
    position: g.position ?? '',
    updated: g.updated ?? '',
  };
}

// Google returns a recently deleted task with a 200 and deleted: true, not a 404 (seen live).
function live(listId: string, g: GoogleTask): Task {
  if (g.deleted === true) throw new NotFoundError(`task ${g.id} in ${listId} is deleted`);
  return toTask(listId, g);
}

function taskBody(fields: { title?: string; notes?: string; due?: string | null }) {
  const body: Record<string, unknown> = {};
  if (fields.title !== undefined) body.title = fields.title;
  if (fields.notes !== undefined) body.notes = fields.notes;
  if (fields.due !== undefined) body.due = fields.due === null ? null : toGoogleDue(fields.due);
  return body;
}

export function createHttpGoogle(
  getToken: () => Promise<string>,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): GoogleApi {
  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await getToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    let res: Response;
    try {
      res = await fetchFn(url, { ...init, headers });
    } catch (cause) {
      throw new OfflineError(cause instanceof Error ? cause.message : 'network failure');
    }
    if (res.ok) return res;
    const message = `${init.method ?? 'GET'} ${url} failed with ${res.status}`;
    if (res.status === 401) throw new AuthError(message);
    if (res.status === 404 || res.status === 410) throw new NotFoundError(message);
    throw new HttpError(res.status, message);
  }

  const jsonInit = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  async function pages<T>(base: string, params: URLSearchParams): Promise<T[]> {
    const all: T[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams(params);
      query.set('maxResults', '100');
      if (pageToken) query.set('pageToken', pageToken);
      const page: Page<T> = await (await request(`${base}?${query}`)).json();
      all.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return all;
  }

  const taskUrl = (listId: string, taskId: string) =>
    `${TASKS}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`;
  const listUrl = (listId: string) => `${TASKS}/users/@me/lists/${encodeURIComponent(listId)}`;

  async function findBoard(): Promise<DriveFile | null> {
    const query = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `name='${BOARD_NAME}'`,
      fields: 'files(id,version)',
      // Every device settles on the oldest board.json if two ever exist.
      orderBy: 'createdTime',
    });
    const res = await request(`${DRIVE}?${query}`);
    const { files }: { files?: DriveFile[] } = await res.json();
    return files?.[0] ?? null;
  }

  async function fileVersion(id: string): Promise<string> {
    const res = await request(`${DRIVE}/${id}?fields=version`);
    const { version }: DriveFile = await res.json();
    if (version === undefined) throw new HttpError(502, `No version returned for file ${id}`);
    return String(version);
  }

  return {
    async getAccount() {
      const res = await request(`${DRIVE_ABOUT}?fields=user(emailAddress,displayName)`);
      const { user }: { user?: { emailAddress?: string; displayName?: string } } = await res.json();
      // Without an email the token can't be matched to an account, so this counts as a failed call.
      if (!user?.emailAddress) throw new HttpError(502, 'No account returned');
      return { email: user.emailAddress, name: user.displayName ?? '' };
    },

    async listTaskLists() {
      const lists = await pages<TaskList>(`${TASKS}/users/@me/lists`, new URLSearchParams());
      return lists.map((l) => ({ id: l.id, title: l.title }));
    },

    async getDefaultListId() {
      const res = await request(`${TASKS}/users/@me/lists/@default`);
      return ((await res.json()) as TaskList).id;
    },

    async insertTaskList(title) {
      const res = await request(`${TASKS}/users/@me/lists`, jsonInit('POST', { title }));
      const list = (await res.json()) as TaskList;
      return { id: list.id, title: list.title };
    },

    async patchTaskList(listId, title) {
      const res = await request(listUrl(listId), jsonInit('PATCH', { title }));
      const list = (await res.json()) as TaskList;
      return { id: list.id, title: list.title };
    },

    async deleteTaskList(listId) {
      await request(listUrl(listId), { method: 'DELETE' });
    },

    async listTasks(listId, completedSince) {
      const base = `${TASKS}/lists/${encodeURIComponent(listId)}/tasks`;
      const open = await pages<GoogleTask>(base, new URLSearchParams({ showCompleted: 'false' }));
      // No completedMin: it would also drop old completed subtasks, which the step count needs.
      const all = await pages<GoogleTask>(
        base,
        new URLSearchParams({ showCompleted: 'true', showHidden: 'true' }),
      );
      const done = all.filter(
        (g) =>
          g.status === 'completed' &&
          (g.parent !== undefined || (g.completed ?? '') >= completedSince),
      );
      const byId = new Map<string, Task>();
      for (const g of [...open, ...done]) if (g.deleted !== true) byId.set(g.id, toTask(listId, g));
      return [...byId.values()];
    },

    async getTask(listId, taskId) {
      const res = await request(taskUrl(listId, taskId));
      return live(listId, await res.json());
    },

    async insertTask(listId, input: NewTask) {
      const query = new URLSearchParams();
      if (input.parent) query.set('parent', input.parent);
      if (input.previous) query.set('previous', input.previous);
      const suffix = query.size > 0 ? `?${query}` : '';
      const res = await request(
        `${TASKS}/lists/${encodeURIComponent(listId)}/tasks${suffix}`,
        jsonInit('POST', taskBody(input)),
      );
      return toTask(listId, await res.json());
    },

    async patchTask(listId, taskId, patch: TaskPatch) {
      const body = taskBody(patch);
      if (patch.completed === true) body.status = 'completed';
      // Google keeps the old completion time unless it is cleared explicitly.
      if (patch.completed === false)
        Object.assign(body, { status: 'needsAction', completed: null });
      const res = await request(taskUrl(listId, taskId), jsonInit('PATCH', body));
      return live(listId, await res.json());
    },

    async deleteTask(listId, taskId) {
      await request(taskUrl(listId, taskId), { method: 'DELETE' });
    },

    async moveTask(listId, taskId, destinationListId) {
      const query = new URLSearchParams({ destinationTasklist: destinationListId });
      const res = await request(`${taskUrl(listId, taskId)}/move?${query}`, { method: 'POST' });
      return live(destinationListId, await res.json());
    },

    async reorderTask(listId, taskId, parent, previous) {
      const query = new URLSearchParams({ parent });
      if (previous !== null) query.set('previous', previous);
      const res = await request(`${taskUrl(listId, taskId)}/move?${query}`, { method: 'POST' });
      return live(listId, await res.json());
    },

    async readBoard() {
      const file = await findBoard();
      if (!file) return { raw: null, version: null };
      // writeBoard checks the version on the file itself, so read it the same way.
      // Version first: a write landing in between then pairs newer content with an
      // older version, which only costs a retry, never an overwrite.
      const version = await fileVersion(file.id);
      const res = await request(`${DRIVE}/${file.id}?alt=media`);
      return { raw: await res.text(), version };
    },

    async writeBoard(raw, expectedVersion) {
      const file = await findBoard();
      if (!file) {
        if (expectedVersion !== null) return 'conflict';
        const boundary = `todo-${Math.random().toString(36).slice(2)}`;
        const metadata = JSON.stringify({ name: BOARD_NAME, parents: ['appDataFolder'] });
        const body =
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
          `--${boundary}\r\nContent-Type: application/json\r\n\r\n${raw}\r\n--${boundary}--`;
        await request(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id,version`, {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body,
        });
        return 'ok';
      }
      if (expectedVersion === null) return 'conflict';
      // The listing can lag behind writes, so check the version on the file itself.
      if ((await fileVersion(file.id)) !== expectedVersion) return 'conflict';
      await request(`${DRIVE_UPLOAD}/${file.id}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
      });
      return 'ok';
    },
  };
}
