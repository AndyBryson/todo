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

const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
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

  async function findBoard(): Promise<DriveFile | null> {
    const query = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `name='${BOARD_NAME}'`,
      fields: 'files(id,version)',
    });
    const res = await request(`${DRIVE}?${query}`);
    const { files }: { files?: DriveFile[] } = await res.json();
    return files?.[0] ?? null;
  }

  return {
    async listTaskLists() {
      const lists = await pages<TaskList>(`${TASKS}/users/@me/lists`, new URLSearchParams());
      return lists.map((l) => ({ id: l.id, title: l.title }));
    },

    async listTasks(listId, completedSince) {
      const base = `${TASKS}/lists/${encodeURIComponent(listId)}/tasks`;
      const open = await pages<GoogleTask>(base, new URLSearchParams({ showCompleted: 'false' }));
      const done = await pages<GoogleTask>(
        base,
        new URLSearchParams({
          showCompleted: 'true',
          showHidden: 'true',
          completedMin: completedSince,
        }),
      );
      const byId = new Map<string, Task>();
      for (const g of [...open, ...done]) byId.set(g.id, toTask(listId, g));
      return [...byId.values()];
    },

    async getTask(listId, taskId) {
      const res = await request(taskUrl(listId, taskId));
      return toTask(listId, await res.json());
    },

    async insertTask(listId, input: NewTask) {
      const query = new URLSearchParams();
      if (input.parent) query.set('parent', input.parent);
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
      return toTask(listId, await res.json());
    },

    async deleteTask(listId, taskId) {
      await request(taskUrl(listId, taskId), { method: 'DELETE' });
    },

    async moveTask(listId, taskId, destinationListId) {
      const query = new URLSearchParams({ destinationTasklist: destinationListId });
      const res = await request(`${taskUrl(listId, taskId)}/move?${query}`, { method: 'POST' });
      return toTask(destinationListId, await res.json());
    },

    async readBoard() {
      const file = await findBoard();
      if (!file) return { raw: null, version: null };
      const res = await request(`${DRIVE}/${file.id}?alt=media`);
      return { raw: await res.text(), version: String(file.version) };
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
      const res = await request(`${DRIVE}/${file.id}?fields=version`);
      const { version }: DriveFile = await res.json();
      if (String(version) !== expectedVersion) return 'conflict';
      await request(`${DRIVE_UPLOAD}/${file.id}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
      });
      return 'ok';
    },
  };
}
