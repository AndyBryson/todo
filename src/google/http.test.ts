import { describe, expect, test } from 'vitest';
import { AuthError, HttpError, NotFoundError, OfflineError } from './api';
import { createHttpGoogle } from './http';

const SINCE = '2026-11-10T00:00:00.000Z';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function stub(handler: Handler) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetchFn, requests };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  status: 'needsAction',
  position: '0',
  updated: '2026-11-17T08:00:00.000Z',
  ...extra,
});

const api = (handler: Handler) => {
  const s = stub(handler);
  return { google: createHttpGoogle(async () => 't', s.fetchFn), ...s };
};

describe('listTasks', () => {
  test('follows every page so a long list is never cut short', async () => {
    const { google, requests } = api((url) => {
      if (url.searchParams.get('showCompleted') === 'true') return json({ items: [item('done')] });
      if (url.searchParams.get('pageToken') === 'p2') {
        return json({ items: Array.from({ length: 150 }, (_, i) => item(`b${i}`)) });
      }
      return json({
        items: Array.from({ length: 100 }, (_, i) => item(`a${i}`)),
        nextPageToken: 'p2',
      });
    });
    const tasks = await google.listTasks('L1', SINCE);
    expect(tasks).toHaveLength(251);
    // The page count is the behaviour here: open query takes two requests, completed one.
    expect(requests).toHaveLength(3);
  });

  test('follows every page of the completed query too', async () => {
    const { google } = api((url) => {
      if (url.searchParams.get('showCompleted') !== 'true') return json({});
      return url.searchParams.get('pageToken')
        ? json({ items: [item('c2')] })
        : json({ items: [item('c1')], nextPageToken: 'n' });
    });
    expect((await google.listTasks('L1', SINCE)).map((t) => t.id).sort()).toEqual(['c1', 'c2']);
  });

  test('skips tasks Google reports as deleted', async () => {
    const { google } = api(() => json({ items: [item('kept'), item('gone', { deleted: true })] }));
    expect((await google.listTasks('L1', SINCE)).map((t) => t.id)).toEqual(['kept']);
  });

  test('a task in both queries appears once', async () => {
    const { google } = api(() => json({ items: [item('same')] }));
    expect(await google.listTasks('L1', SINCE)).toHaveLength(1);
  });

  test('asks only for completed tasks since the cut-off, including hidden ones', async () => {
    const { google, requests } = api(() => json({}));
    await google.listTasks('L1', SINCE);
    const completed = requests.find((r) => r.url.searchParams.get('showCompleted') === 'true');
    expect(completed?.url.searchParams.get('showHidden')).toBe('true');
    expect(completed?.url.searchParams.get('completedMin')).toBe(SINCE);
  });

  test('maps Google’s due and status to calendar date and completed flag', async () => {
    const { google } = api((url) =>
      url.searchParams.get('showCompleted') === 'true'
        ? json({
            items: [
              item('a', {
                status: 'completed',
                completed: '2026-11-17T09:00:00.000Z',
                due: '2026-11-17T00:00:00.000Z',
              }),
            ],
          })
        : json({}),
    );
    const [task] = await google.listTasks('L1', SINCE);
    expect(task).toMatchObject({
      id: 'a',
      listId: 'L1',
      completed: true,
      completedAt: '2026-11-17T09:00:00.000Z',
      due: '2026-11-17',
      notes: '',
      parent: null,
    });
  });
});

describe('listTaskLists', () => {
  test('follows every page', async () => {
    const { google } = api((url) =>
      url.searchParams.get('pageToken')
        ? json({ items: [{ id: 'L2', title: 'Two' }] })
        : json({ items: [{ id: 'L1', title: 'One' }], nextPageToken: 'n' }),
    );
    expect(await google.listTaskLists()).toEqual([
      { id: 'L1', title: 'One' },
      { id: 'L2', title: 'Two' },
    ]);
  });
});

describe('errors', () => {
  test('401 is an AuthError and a network failure is an OfflineError', async () => {
    const unauthorised = api(() => json({}, 401));
    await expect(unauthorised.google.listTaskLists()).rejects.toBeInstanceOf(AuthError);

    const offline = createHttpGoogle(async () => 't', (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch);
    await expect(offline.listTaskLists()).rejects.toBeInstanceOf(OfflineError);
  });

  test('404, 410 and a task marked deleted are NotFoundError; other failures keep their status', async () => {
    for (const status of [404, 410]) {
      const { google } = api(() => json({}, status));
      await expect(google.getTask('L', 't')).rejects.toBeInstanceOf(NotFoundError);
      await expect(google.deleteTask('L', 't')).rejects.toBeInstanceOf(NotFoundError);
      await expect(google.patchTask('L', 't', { title: 'x' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(google.moveTask('L', 't', 'M')).rejects.toBeInstanceOf(NotFoundError);
    }
    const deleted = api(() => json(item('t', { deleted: true })));
    await expect(deleted.google.getTask('L', 't')).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleted.google.patchTask('L', 't', { title: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(deleted.google.moveTask('L', 't', 'M')).rejects.toBeInstanceOf(NotFoundError);

    const { google } = api(() => json({}, 503));
    await expect(google.getTask('L', 't')).rejects.toMatchObject({
      constructor: HttpError,
      status: 503,
    });
  });
});

describe('writes', () => {
  test('reopening sends needsAction and clears the completion time', async () => {
    const { google, requests } = api(() => json(item('a')));
    await google.patchTask('L', 'a', { completed: false });
    const body = JSON.parse(String(requests[0]?.init.body));
    expect(body).toEqual({ status: 'needsAction', completed: null });
    expect(requests[0]?.init.method).toBe('PATCH');
  });

  test('completing sends status completed; clearing a due date sends null', async () => {
    const { google, requests } = api(() => json(item('a')));
    await google.patchTask('L', 'a', { completed: true, due: null });
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      status: 'completed',
      due: null,
    });
  });

  test('a due date goes out as midnight UTC', async () => {
    const { google, requests } = api(() => json(item('a')));
    await google.patchTask('L', 'a', { due: '2026-11-17' });
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      due: '2026-11-17T00:00:00.000Z',
    });
  });

  test('insert passes the parent as a query parameter and sends the bearer token', async () => {
    const { google, requests } = api(() => json(item('new', { parent: 'p' })));
    const task = await google.insertTask('L', { title: 'Sub', parent: 'p' });
    expect(requests[0]?.url.searchParams.get('parent')).toBe('p');
    expect(new Headers(requests[0]?.init.headers).get('Authorization')).toBe('Bearer t');
    expect(task.parent).toBe('p');
  });

  test('reorderTask moves under the parent after the previous sibling', async () => {
    const { google, requests } = api(() => json(item('t2', { parent: 'p', position: '5' })));
    const task = await google.reorderTask('L1', 't2', 'p', 't1');
    expect(requests[0]?.init.method).toBe('POST');
    expect(requests[0]?.url.pathname).toBe('/tasks/v1/lists/L1/tasks/t2/move');
    expect(requests[0]?.url.searchParams.get('parent')).toBe('p');
    expect(requests[0]?.url.searchParams.get('previous')).toBe('t1');
    expect(task).toMatchObject({ id: 't2', parent: 'p', position: '5' });
  });

  test('reorderTask with no previous sends parent only', async () => {
    const { google, requests } = api(() => json(item('t2', { parent: 'p' })));
    await google.reorderTask('L1', 't2', 'p', null);
    expect(requests[0]?.url.searchParams.get('parent')).toBe('p');
    expect(requests[0]?.url.searchParams.has('previous')).toBe(false);
  });

  test('move names the destination list and returns the moved task', async () => {
    const { google, requests } = api(() => json(item('a')));
    const task = await google.moveTask('L', 'a', 'M');
    expect(requests[0]?.url.pathname).toBe('/tasks/v1/lists/L/tasks/a/move');
    expect(requests[0]?.url.searchParams.get('destinationTasklist')).toBe('M');
    expect(task.listId).toBe('M');
  });
});

describe('board file', () => {
  test('reads nothing when no board file exists yet', async () => {
    const { google } = api(() => json({ files: [] }));
    expect(await google.readBoard()).toEqual({ raw: null, version: null });
  });

  test('reads the version from the file itself, before the content', async () => {
    const { google, requests } = api((url) => {
      if (url.searchParams.get('alt') === 'media') return new Response('{"version":1}');
      if (url.searchParams.get('fields') === 'version') return json({ version: '7' });
      return json({ files: [{ id: 'F', version: '3' }] });
    });
    expect(await google.readBoard()).toEqual({ raw: '{"version":1}', version: '7' });
    // Content newer than its version only costs a retry; the reverse would overwrite a write.
    expect(
      requests.map((r) => r.url.searchParams.get('alt') ?? r.url.searchParams.get('fields')),
    ).toEqual(['files(id,version)', 'version', 'media']);
  });

  test('first write creates the file in appDataFolder', async () => {
    const { google, requests } = api((url) =>
      url.pathname.startsWith('/upload/') ? json({ id: 'F', version: 1 }) : json({ files: [] }),
    );
    expect(await google.writeBoard('{"a":1}', null)).toBe('ok');
    const create = requests.find((r) => r.init.method === 'POST');
    expect(create?.url.pathname).toBe('/upload/drive/v3/files');
    expect(create?.url.searchParams.get('uploadType')).toBe('multipart');
    const body = String(create?.init.body);
    expect(body).toContain('"parents":["appDataFolder"]');
    expect(body).toContain('{"a":1}');
  });

  test('a changed remote version is a conflict and nothing is uploaded', async () => {
    const { google, requests } = api((url) =>
      url.pathname.endsWith('/F')
        ? json({ version: '9' })
        : json({ files: [{ id: 'F', version: '9' }] }),
    );
    expect(await google.writeBoard('{}', '8')).toBe('conflict');
    expect(requests.some((r) => r.init.method === 'PATCH' || r.init.method === 'POST')).toBe(false);
  });

  test('creating when a file already exists is a conflict', async () => {
    const { google } = api(() => json({ files: [{ id: 'F', version: '2' }] }));
    expect(await google.writeBoard('{}', null)).toBe('conflict');
  });

  test('a matching version overwrites the content', async () => {
    const { google, requests } = api((url, init) => {
      if (init.method === 'PATCH') return json({ id: 'F', version: '9' });
      return url.pathname.endsWith('/F')
        ? json({ version: '8' })
        : json({ files: [{ id: 'F', version: '8' }] });
    });
    expect(await google.writeBoard('{"b":2}', '8')).toBe('ok');
    const patch = requests.find((r) => r.init.method === 'PATCH');
    expect(patch?.url.href.startsWith('https://www.googleapis.com/upload/drive/v3/files/F')).toBe(
      true,
    );
    expect(patch?.url.searchParams.get('uploadType')).toBe('media');
    expect(patch?.init.body).toBe('{"b":2}');
  });
});
