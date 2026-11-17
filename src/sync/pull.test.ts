import { beforeEach, expect, test } from 'vitest';
import { parseBoardFile, serialiseBoard } from '../domain/board';
import { entry, task } from '../domain/test-fixtures';
import { OfflineError } from '../google/api';
import { createFakeGoogle, type FakeGoogle } from '../google/fake';
import { openStore, type Store } from '../store/db';
import { addTask, editTask } from '../store/edits';
import { pull } from './pull';

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
  await store.replaceRemote(LISTS, tasks);
  await store.setEntries({ a: entry(), b: entry(), gone: entry() });
  const before = store.snapshot();
  const versionBefore = google.board.version;

  google.failOn('listTasks', new OfflineError(), { after: 1 });
  await expect(pull(google, store, NOW)).rejects.toBeInstanceOf(OfflineError);

  expect(store.snapshot().entries).toEqual(before.entries);
  expect(store.snapshot().tasks).toEqual(before.tasks);
  expect(google.board.version).toBe(versionBefore);
});

test('a task added in Google Home appears at the bottom of Backlog and is written to Drive', async () => {
  google = createFakeGoogle({ lists: LISTS, tasks: [task('a')], board: file({ a: entry() }) });
  google.tasks.set('home', task('home'));
  await pull(google, store, NOW);
  expect(store.snapshot().entries.home?.column).toBe('Backlog');
  expect(store.snapshot().entries.home?.rank).toBeGreaterThan(1024);
  expect(parseBoardFile(google.board.raw).home).toBeDefined();
});

test('another device’s newer move survives a merge with our older entry', async () => {
  google = createFakeGoogle({
    lists: LISTS,
    tasks: [task('a')],
    board: file({ a: entry({ column: 'Doing', openColumn: 'Doing', updatedAt: LATER }) }),
  });
  await store.setEntries({ a: entry({ column: 'Next', openColumn: 'Next' }) });
  await pull(google, store, NOW);
  expect(store.snapshot().entries.a?.column).toBe('Doing');
});

test('our newer move wins over an older remote entry and is written to Drive', async () => {
  google = createFakeGoogle({ lists: LISTS, tasks: [task('a')], board: file({ a: entry() }) });
  await store.setEntries({ a: entry({ column: 'Next', openColumn: 'Next', updatedAt: LATER }) });
  await pull(google, store, NOW);
  expect(parseBoardFile(google.board.raw).a?.column).toBe('Next');
});

test('losing the write race re-reads and keeps both devices’ changes', async () => {
  google = createFakeGoogle({
    lists: LISTS,
    tasks: [task('a'), task('b', { position: '1' })],
    board: file({ a: entry(), b: entry({ rank: 2048 }) }),
  });
  await store.setEntries({
    a: entry({ column: 'Next', openColumn: 'Next', updatedAt: LATER }),
    b: entry({ rank: 2048 }),
  });
  google.onAfter('readBoard', () => {
    // The fake closes over its board object, so mutate it rather than replace it.
    google.board.raw = file({
      a: entry(),
      b: entry({ column: 'Waiting', openColumn: 'Waiting', rank: 2048, updatedAt: LATER }),
    });
    google.board.version += 1;
  });
  await pull(google, store, NOW);
  const remote = parseBoardFile(google.board.raw);
  expect(remote.a?.column).toBe('Next');
  expect(remote.b?.column).toBe('Waiting');
  expect(google.calls.filter((c) => c.method === 'readBoard')).toHaveLength(2);
});

test('an edit arriving during the fetch is kept and nothing is overwritten', async () => {
  google = createFakeGoogle({
    lists: LISTS,
    tasks: [task('x')],
    board: file({ x: entry() }),
  });
  await store.replaceRemote(LISTS, [task('x')]);
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
  await store.replaceRemote(LISTS, [task('x')]);
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
