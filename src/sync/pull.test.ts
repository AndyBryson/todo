import { beforeEach, expect, test } from 'vitest';
import { buildBoard, parseBoardFile, serialiseBoard } from '../domain/board';
import { DEFAULT_FILTERS } from '../domain/filters';
import { subtasksOf } from '../domain/subtasks';
import { entry, task } from '../domain/test-fixtures';
import { OfflineError } from '../google/api';
import { createFakeGoogle, type FakeGoogle, fakePosition } from '../google/fake';
import { openStore, type Store } from '../store/db';
import { addTask, editTask, reorderSubtask } from '../store/edits';
import { pull } from './pull';
import { replay } from './push';

const NOW = new Date('2026-11-17T10:00:00Z');
const LATER = '2026-11-17T09:00:00Z';
const LISTS = [
  { id: 'L1', title: 'One' },
  { id: 'L2', title: 'Two' },
];
let store: Store;
let google: FakeGoogle;

const file = (entries: Record<string, ReturnType<typeof entry>>) => serialiseBoard(entries);

beforeEach(async () => {
  store = await openStore(`test-${crypto.randomUUID()}`);
});

test('a pull that fails partway writes nothing and prunes nothing', async () => {
  const tasks = [task('a'), task('b', { listId: 'L2' })];
  google = createFakeGoogle({ lists: LISTS, tasks, board: file({ a: entry(), b: entry() }) });
  await store.commit({ replaceRemote: { lists: LISTS, tasks } });
  await store.commit({ replaceEntries: { a: entry(), b: entry(), gone: entry() } });
  const before = store.snapshot();
  const versionBefore = google.board.version;

  google.failOn('listTasks', new OfflineError(), { after: 1 });
  await expect(pull(google, store, NOW)).rejects.toBeInstanceOf(OfflineError);

  expect(store.snapshot().entries).toEqual(before.entries);
  expect(store.snapshot().tasks).toEqual(before.tasks);
  expect(google.board.version).toBe(versionBefore);
});

test('a task added in Google Home to My Tasks lands in Next and is written to Drive', async () => {
  // The fake's default list is its first list, L1.
  google = createFakeGoogle({ lists: LISTS, tasks: [task('a')], board: file({ a: entry() }) });
  google.tasks.set('home', task('home', { listId: 'L1' }));
  await pull(google, store, NOW);
  expect(store.snapshot().defaultListId).toBe('L1');
  expect(store.snapshot().entries.home?.column).toBe('Next');
  expect(parseBoardFile(google.board.raw).home?.column).toBe('Next');
});

test('a task added in Google to another list lands at the bottom of Backlog', async () => {
  google = createFakeGoogle({ lists: LISTS, tasks: [task('a')], board: file({ a: entry() }) });
  google.tasks.set('work', task('work', { listId: 'L2' }));
  await pull(google, store, NOW);
  expect(store.snapshot().entries.work?.column).toBe('Backlog');
  expect(store.snapshot().entries.work?.rank).toBeGreaterThan(1024);
});

test('another device’s newer move survives a merge with our older entry', async () => {
  google = createFakeGoogle({
    lists: LISTS,
    tasks: [task('a')],
    board: file({ a: entry({ column: 'Doing', openColumn: 'Doing', updatedAt: LATER }) }),
  });
  await store.commit({ replaceEntries: { a: entry({ column: 'Next', openColumn: 'Next' }) } });
  await pull(google, store, NOW);
  expect(store.snapshot().entries.a?.column).toBe('Doing');
});

test('our newer move wins over an older remote entry and is written to Drive', async () => {
  google = createFakeGoogle({ lists: LISTS, tasks: [task('a')], board: file({ a: entry() }) });
  await store.commit({
    replaceEntries: { a: entry({ column: 'Next', openColumn: 'Next', updatedAt: LATER }) },
  });
  await pull(google, store, NOW);
  expect(parseBoardFile(google.board.raw).a?.column).toBe('Next');
});

test('losing the write race re-reads and keeps both devices’ changes', async () => {
  google = createFakeGoogle({
    lists: LISTS,
    tasks: [task('a'), task('b', { position: '1' })],
    board: file({ a: entry(), b: entry({ rank: 2048 }) }),
  });
  await store.commit({
    replaceEntries: {
      a: entry({ column: 'Next', openColumn: 'Next', updatedAt: LATER }),
      b: entry({ rank: 2048 }),
    },
  });
  google.onAfter('readBoard', () => {
    // The fake closes over its board object, so mutate it rather than replace it.
    google.board.raw = file({
      a: entry(),
      b: entry({ column: 'Doing', openColumn: 'Doing', rank: 2048, updatedAt: LATER }),
    });
    google.board.version += 1;
  });
  await pull(google, store, NOW);
  const remote = parseBoardFile(google.board.raw);
  expect(remote.a?.column).toBe('Next');
  expect(remote.b?.column).toBe('Doing');
  expect(google.calls.filter((c) => c.method === 'readBoard')).toHaveLength(2);
});

test('an edit arriving during the fetch is kept and nothing is overwritten', async () => {
  google = createFakeGoogle({
    lists: LISTS,
    tasks: [task('x')],
    board: file({ x: entry() }),
  });
  await store.commit({ replaceRemote: { lists: LISTS, tasks: [task('x')] } });
  let tempId = '';
  google.onAfter('listTasks', () => {
    void (async () => {
      await editTask(store, 'x', { title: 'Mine' });
      tempId = await addTask(
        store,
        { listId: 'L1', title: 'New', pinned: false },
        NOW.toISOString(),
      );
    })();
  });
  // Let the hook's async edits finish before pull's own queue check.
  const realListTasks = google.listTasks.bind(google);
  google.listTasks = async (...args) => {
    const result = await realListTasks(...args);
    await new Promise((r) => setTimeout(r, 20));
    return result;
  };

  expect(await pull(google, store, NOW)).toBe('skipped');
  expect(tempId).not.toBe('');
  expect(store.snapshot().tasks.find((t) => t.id === 'x')?.title).toBe('Mine');
  expect(store.snapshot().tasks.map((t) => t.id)).toContain(tempId);
  expect(store.snapshot().queueLength).toBe(2);
});

test('an edit arriving during board sync stops the write, keeping local-only tasks', async () => {
  google = createFakeGoogle({ lists: LISTS, tasks: [task('x')], board: file({ x: entry() }) });
  await store.commit({ replaceRemote: { lists: LISTS, tasks: [task('x')] } });
  let tempId = '';
  google.onAfter('readBoard', () => {
    void addTask(store, { listId: 'L1', title: 'New', pinned: false }, NOW.toISOString()).then(
      (id) => {
        tempId = id;
      },
    );
  });
  google.writeBoard = new Proxy(google.writeBoard, {
    apply: async (target, self, args) => {
      await new Promise((r) => setTimeout(r, 20));
      return Reflect.apply(target, self, args);
    },
  });
  // Force a board write so the await window exists.
  google.board.raw = file({});
  await pull(google, store, NOW);
  expect(store.snapshot().tasks.map((t) => t.id)).toContain(tempId);
});

test('board.json never contains task titles', async () => {
  google = createFakeGoogle({
    lists: LISTS,
    tasks: [task('a', { title: 'Buy milk', notes: 'semi-skimmed' })],
  });
  await pull(google, store, NOW);
  expect(google.board.raw).not.toContain('Buy milk');
  expect(google.board.raw).not.toContain('semi-skimmed');
});

test('the same entries in a different key order are not rewritten to Drive', async () => {
  google = createFakeGoogle({
    lists: LISTS,
    tasks: [task('a'), task('b', { position: '1' })],
    board: file({ a: entry(), b: entry({ rank: 2048 }) }),
  });
  await store.commit({ replaceEntries: { b: entry({ rank: 2048 }), a: entry() } });
  await pull(google, store, NOW);
  expect(google.calls.some((c) => c.method === 'writeBoard')).toBe(false);
});

test("Google's order replaces the local one after a pull", async () => {
  // Spaced like real Google, so the pulled positions differ from the local renumbering.
  const spacing = 2 ** 30;
  const tasks = [
    task('x'),
    ...['s1', 's2', 's3'].map((id, i) =>
      task(id, { parent: 'x', position: fakePosition(BigInt(i * spacing)) }),
    ),
  ];
  google = createFakeGoogle({
    lists: LISTS,
    tasks,
    board: file({ x: entry() }),
    positionSpacing: spacing,
  });
  await store.commit({ replaceRemote: { lists: LISTS, tasks } });
  await reorderSubtask(store, 's3', null, NOW.toISOString());
  expect(await replay(google, store)).toBe('done');
  // Someone else moves s1 to the end before we pull.
  await google.reorderTask('L1', 's1', 'x', 's2');
  expect(google.tasks.get('s1')?.position).not.toBe(
    store.snapshot().tasks.find((t) => t.id === 's1')?.position,
  );
  await pull(google, store, NOW);
  const local = subtasksOf(store.snapshot().tasks, 'x');
  expect(local.map((t) => t.id)).toEqual(['s3', 's2', 's1']);
  expect(local.map((t) => t.position)).toEqual(
    ['s3', 's2', 's1'].map((id) => google.tasks.get(id)?.position),
  );
});

test('a step ticked 30 days ago still counts on its card; an old top-level task does not show', async () => {
  const longAgo = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  google = createFakeGoogle({
    lists: LISTS,
    tasks: [
      task('p'),
      task('s1', { parent: 'p', completed: true, completedAt: longAgo }),
      task('s2', { parent: 'p' }),
      task('old', { completed: true, completedAt: longAgo }),
    ],
    board: file({ p: entry() }),
  });
  await pull(google, store, NOW);
  const { tasks, lists, entries } = store.snapshot();
  expect(tasks.map((t) => t.id).sort()).toEqual(['p', 's1', 's2']);
  const board = buildBoard(tasks, lists, entries, DEFAULT_FILTERS, NOW);
  expect(board.Backlog[0]?.steps).toEqual({ done: 1, total: 2 });
  expect(board.Done).toEqual([]);
});
