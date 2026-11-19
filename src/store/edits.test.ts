import { beforeEach, describe, expect, test } from 'vitest';
import { subtasksOf } from '../domain/subtasks';
import { entry, task } from '../domain/test-fixtures';
import { type Op, openStore, renameChange, type Store } from './db';
import {
  addSubtask,
  addTask,
  copyToAccount,
  deleteTask,
  editTask,
  hasUnsent,
  moveCard,
  moveCardsToBottom,
  moveCardToBottom,
  moveToList,
  putEntries,
  reorderSubtask,
  setCompleted,
  setPinned,
  setPriority,
} from './edits';

const NOW = '2026-11-17T10:00:00Z';
const OLD_DONE = '2026-11-10T00:00:00Z';
let store: Store;
let name: string;

beforeEach(async () => {
  name = `test-${crypto.randomUUID()}`;
  store = await openStore(name);
  await store.commit({
    replaceRemote: {
      lists: [
        { id: 'L1', title: 'One' },
        { id: 'L2', title: 'Two' },
      ],
      tasks: [task('x')],
    },
  });
});

const ops = async () => store.snapshot().queued.map((q) => q.op);

test('dragging to Done completes the task in Google and clears the pin', async () => {
  await store.commit({
    replaceEntries: { x: entry({ column: 'Doing', openColumn: 'Doing', pinned: true }) },
  });
  await moveCard(store, 'x', 'Done', null, NOW);
  const s = store.snapshot();
  expect(s.entries.x).toMatchObject({ column: 'Done', openColumn: 'Doing', pinned: false });
  expect(await ops()).toEqual([
    {
      kind: 'patch',
      listId: 'L1',
      taskId: 'x',
      set: { completed: true },
      base: { completed: false },
    },
  ]);
});

test('dragging out of Done reopens the task in Google', async () => {
  await store.commit({ putTasks: [task('x', { completed: true, completedAt: OLD_DONE })] });
  await store.commit({ replaceEntries: { x: entry({ column: 'Done', openColumn: 'Next' }) } });
  await moveCard(store, 'x', 'Doing', null, NOW);
  const s = store.snapshot();
  expect(s.entries.x).toMatchObject({ column: 'Doing', openColumn: 'Doing' });
  expect(s.tasks.find((t) => t.id === 'x')).toMatchObject({ completed: false, completedAt: null });
  expect(await ops()).toEqual([
    {
      kind: 'patch',
      listId: 'L1',
      taskId: 'x',
      set: { completed: false },
      base: { completed: true },
    },
  ]);
});

test('moving between open columns places the card and queues nothing', async () => {
  await store.commit({ putTasks: [task('a')] });
  await store.commit({
    replaceEntries: {
      x: entry({ column: 'Next', openColumn: 'Next', rank: 1024 }),
      a: entry({ column: 'Doing', openColumn: 'Doing', rank: 1024 }),
    },
  });
  await moveCard(store, 'x', 'Doing', 'a', NOW);
  const { entries } = store.snapshot();
  expect(entries.x).toMatchObject({ column: 'Doing', openColumn: 'Doing', updatedAt: NOW });
  expect(entries.x?.rank).toBeGreaterThan(entries.a?.rank ?? 0);
  expect(await ops()).toEqual([]);
});

test('quick add from Today pins it and puts it at the bottom of Backlog in the chosen list', async () => {
  await store.commit({ replaceEntries: { x: entry({ rank: 5000 }) } });
  const id = await addTask(store, { listId: 'L2', title: '  Buy milk ', pinned: true }, NOW);
  const s = store.snapshot();
  expect(s.tasks.find((t) => t.id === id)?.title).toBe('Buy milk');
  expect(s.entries[id]).toMatchObject({ column: 'Backlog', pinned: true });
  expect(s.entries[id]?.rank).toBeGreaterThan(5000);
  expect(s.lastListId).toBe('L2');
  expect(await ops()).toEqual([
    { kind: 'create', listId: 'L2', tempId: id, task: { title: 'Buy milk' } },
  ]);
});

test('blank quick add is refused', async () => {
  await expect(
    addTask(store, { listId: 'L1', title: '   ', pinned: false }, NOW),
  ).rejects.toThrow();
  expect(await ops()).toEqual([]);
});

test('an edit records the previous values as the patch base', async () => {
  await store.commit({ putTasks: [task('x', { title: 'Old', due: '2026-11-20' })] });
  await editTask(store, 'x', { title: 'New', due: null });
  expect(await ops()).toEqual([
    {
      kind: 'patch',
      listId: 'L1',
      taskId: 'x',
      set: { title: 'New', due: null },
      base: { title: 'Old', due: '2026-11-20' },
    },
  ]);
});

test('moving to another list takes subtasks along and queues the old list', async () => {
  await store.commit({ putTasks: [task('sub', { parent: 'x' })] });
  await moveToList(store, 'x', 'L2');
  const s = store.snapshot();
  expect(
    s.tasks
      .filter((t) => t.listId === 'L2')
      .map((t) => t.id)
      .sort(),
  ).toEqual(['sub', 'x']);
  expect(await ops()).toEqual([{ kind: 'move', listId: 'L1', taskId: 'x', toListId: 'L2' }]);
});

test('deleting removes the task, subtasks and card and queues one delete', async () => {
  await store.commit({ putTasks: [task('sub', { parent: 'x' })] });
  await store.commit({ replaceEntries: { x: entry() } });
  await deleteTask(store, 'x');
  const s = store.snapshot();
  expect(s.tasks).toEqual([]);
  expect(s.entries).toEqual({});
  expect(await ops()).toEqual([{ kind: 'delete', listId: 'L1', taskId: 'x' }]);
});

test('editing ignores undefined keys, refuses a blank title and queues nothing when empty', async () => {
  await editTask(store, 'x', { title: undefined });
  expect(await ops()).toEqual([]);
  await expect(editTask(store, 'x', { title: '  ' })).rejects.toThrow();
  expect(await ops()).toEqual([]);
});

test('completing a subtask patches the task and has no card to move', async () => {
  await store.commit({ putTasks: [task('sub', { parent: 'x' })] });
  await setCompleted(store, 'sub', true, NOW);
  const s = store.snapshot();
  expect(s.tasks.find((t) => t.id === 'sub')).toMatchObject({ completed: true, completedAt: NOW });
  expect(s.entries).toEqual({});
  expect(await ops()).toEqual([
    {
      kind: 'patch',
      listId: 'L1',
      taskId: 'sub',
      set: { completed: true },
      base: { completed: false },
    },
  ]);
});

test('completing an already completed task queues nothing', async () => {
  await store.commit({ putTasks: [task('x', { completed: true, completedAt: OLD_DONE })] });
  await setCompleted(store, 'x', true, NOW);
  expect(await ops()).toEqual([]);
});

test('pinning updates the card and queues nothing', async () => {
  await store.commit({ replaceEntries: { x: entry() } });
  await setPinned(store, 'x', true, NOW);
  expect(store.snapshot().entries.x).toMatchObject({ pinned: true, updatedAt: NOW });
  expect(await ops()).toEqual([]);
});

test('setting a priority saves it on the card and queues nothing for Google', async () => {
  await store.commit({ replaceEntries: { x: entry() } });
  await setPriority(store, 'x', 'highest', NOW);
  expect(store.snapshot().entries.x).toMatchObject({ priority: 'highest', updatedAt: NOW });
  expect(await ops()).toEqual([]);
});

test('setting Medium removes the stored priority', async () => {
  await store.commit({ replaceEntries: { x: entry({ priority: 'low' }) } });
  await setPriority(store, 'x', 'medium', NOW);
  const saved = store.snapshot().entries.x;
  expect(saved).toBeDefined();
  expect(saved).not.toHaveProperty('priority');
  expect(saved?.updatedAt).toBe(NOW);
});

test('setting the same priority again saves nothing', async () => {
  await store.commit({ replaceEntries: { x: entry({ priority: 'high' }) } });
  const before = store.snapshot();
  await setPriority(store, 'x', 'high', NOW);
  await setPriority(store, 'x', 'high', NOW);
  expect(store.snapshot()).toBe(before);
});

test('a task with no card cannot be given a priority', async () => {
  await expect(setPriority(store, 'x', 'high', NOW)).rejects.toThrow();
  await expect(setPriority(store, 'nope', 'high', NOW)).rejects.toThrow();
});

test('a subtask cannot move list on its own', async () => {
  await store.commit({ putTasks: [task('sub', { parent: 'x' })] });
  await expect(moveToList(store, 'sub', 'L2')).rejects.toThrow();
});

test('a failed write changes nothing, in memory or on disk', async () => {
  const before = store.snapshot();
  let calls = 0;
  store.subscribe(() => calls++);
  const unclonable = { ...task('bad'), title: () => 1 } as never;
  await expect(
    store.commit({
      putTasks: [task('good'), unclonable],
      entries: { good: entry() },
      enqueue: [{ kind: 'delete', listId: 'L1', taskId: 'good' }],
    }),
  ).rejects.toThrow();
  expect(store.snapshot()).toBe(before);
  expect(calls).toBe(0);
  const reopened = await openStore(name);
  expect(reopened.snapshot().tasks.map((t) => t.id)).toEqual(['x']);
  expect(reopened.snapshot().queueLength).toBe(0);
});

test('queued ops get increasing seqs even when enqueued together', async () => {
  await Promise.all([
    store.commit({ enqueue: [{ kind: 'delete', listId: 'L1', taskId: 'a' }] }),
    store.commit({ enqueue: [{ kind: 'delete', listId: 'L1', taskId: 'b' }] }),
  ]);
  const seqs = store.snapshot().queued.map((q) => q.seq);
  expect(seqs[1]).toBeGreaterThan(seqs[0] as number);
});

describe('editing with nothing changed queues nothing', () => {
  test.each([
    ['a title equal after trimming', { title: '  x  ' }],
    ['equal notes', { notes: '' }],
    ['a due date staying empty', { due: null }],
  ])('%s', async (_, input) => {
    await editTask(store, 'x', input);
    expect(await ops()).toEqual([]);
  });
});

describe('moving a card to the bottom of a column', () => {
  test('lands after the highest-ranked card', async () => {
    await store.commit({
      putTasks: [task('a'), task('b')],
      replaceEntries: {
        x: entry({ column: 'Next', openColumn: 'Next' }),
        a: entry({ column: 'Doing', openColumn: 'Doing', rank: 3072 }),
        b: entry({ column: 'Doing', openColumn: 'Doing', rank: 1024 }),
      },
    });
    await moveCardToBottom(store, 'x', 'Doing', NOW);
    const { entries } = store.snapshot();
    expect(entries.x).toMatchObject({ column: 'Doing', updatedAt: NOW });
    expect(entries.x?.rank).toBeGreaterThan(entries.a?.rank ?? Number.POSITIVE_INFINITY);
  });

  test('a card already at the bottom stays there', async () => {
    await store.commit({
      putTasks: [task('a')],
      replaceEntries: {
        x: entry({ column: 'Doing', openColumn: 'Doing', rank: 9000 }),
        a: entry({ column: 'Doing', openColumn: 'Doing', rank: 1024 }),
      },
    });
    await moveCardToBottom(store, 'x', 'Doing', NOW);
    const { entries } = store.snapshot();
    expect(entries.x?.rank).toBe(9000);
    expect(entries.a?.rank).toBe(1024);
  });

  test('an empty column takes the card', async () => {
    await store.commit({ replaceEntries: { x: entry({ column: 'Next', openColumn: 'Next' }) } });
    await moveCardToBottom(store, 'x', 'Doing', NOW);
    expect(store.snapshot().entries.x).toMatchObject({ column: 'Doing', openColumn: 'Doing' });
  });

  test('from Done, reopens the task and places it in one write', async () => {
    await store.commit({
      putTasks: [task('x', { completed: true, completedAt: OLD_DONE }), task('a')],
      replaceEntries: {
        x: entry({ column: 'Done', openColumn: 'Doing' }),
        a: entry({ column: 'Next', openColumn: 'Next', rank: 5000 }),
      },
    });
    let writes = 0;
    store.subscribe(() => writes++);
    await moveCardToBottom(store, 'x', 'Next', NOW);
    const s = store.snapshot();
    expect(writes).toBe(1);
    expect(s.entries.x).toMatchObject({ column: 'Next', openColumn: 'Next' });
    expect(s.entries.x?.rank).toBeGreaterThan(5000);
    expect(await ops()).toEqual([
      {
        kind: 'patch',
        listId: 'L1',
        taskId: 'x',
        set: { completed: false },
        base: { completed: true },
      },
    ]);
  });

  test('follows a temporary ID that has since been renamed', async () => {
    await store.commit({ replaceEntries: { x: entry() } });
    await store.commit((s) => renameChange(s, 'x', 'real'));
    await moveCardToBottom(store, 'x', 'Next', NOW);
    expect(store.snapshot().entries.real?.column).toBe('Next');
  });
});

describe('overlapping edits', () => {
  test('two edits to different fields both survive, with correct bases', async () => {
    await Promise.all([
      editTask(store, 'x', { title: 'New title' }),
      editTask(store, 'x', { notes: 'New notes' }),
    ]);
    expect(store.snapshot().tasks.find((t) => t.id === 'x')).toMatchObject({
      title: 'New title',
      notes: 'New notes',
    });
    await Promise.all([editTask(store, 'x', { title: 'A' }), editTask(store, 'x', { title: 'B' })]);
    const patches = (await ops()).slice(2);
    expect(patches).toMatchObject([
      { set: { title: 'A' }, base: { title: 'New title' } },
      { set: { title: 'B' }, base: { title: 'A' } },
    ]);
  });

  test('two quick adds get distinct ranks in order', async () => {
    const [a, b] = await Promise.all([
      addTask(store, { listId: 'L1', title: 'A', pinned: false }, NOW),
      addTask(store, { listId: 'L1', title: 'B', pinned: false }, NOW),
    ]);
    const { entries } = store.snapshot();
    expect(entries[b as string]?.rank).toBeGreaterThan(entries[a as string]?.rank ?? 0);
  });

  test('pinning and completing the same card both apply', async () => {
    await store.commit({ replaceEntries: { x: entry({ column: 'Doing', openColumn: 'Doing' }) } });
    await Promise.all([setPinned(store, 'x', true, NOW), setCompleted(store, 'x', true, NOW)]);
    const s = store.snapshot();
    expect(s.tasks.find((t) => t.id === 'x')?.completed).toBe(true);
    expect(s.entries.x).toMatchObject({ column: 'Done', openColumn: 'Doing' });
  });
});

describe('unknown ids', () => {
  test('every edit throws', async () => {
    await expect(setCompleted(store, 'nope', true, NOW)).rejects.toThrow();
    await expect(setPinned(store, 'nope', true, NOW)).rejects.toThrow();
    await expect(editTask(store, 'nope', { title: 'a' })).rejects.toThrow();
    await expect(moveCard(store, 'nope', 'Next', null, NOW)).rejects.toThrow();
    await expect(moveToList(store, 'nope', 'L2')).rejects.toThrow();
    await expect(deleteTask(store, 'nope')).rejects.toThrow();
  });
});

describe('store', () => {
  test('survives a reopen', async () => {
    await store.commit({ replaceEntries: { x: entry({ column: 'Next', openColumn: 'Next' }) } });
    await store.commit({ enqueue: [{ kind: 'delete', listId: 'L1', taskId: 'x' }] });
    await store.commit({ enqueue: [{ kind: 'delete', listId: 'L1', taskId: 'y' }] });
    await store.setMeta({ lastListId: 'L2' });

    const reopened = await openStore(name);
    const s = reopened.snapshot();
    expect(s.tasks.map((t) => t.id)).toEqual(['x']);
    expect(s.entries.x?.column).toBe('Next');
    expect(s.lastListId).toBe('L2');
    expect(s.queueLength).toBe(2);
    const queued = reopened.snapshot().queued;
    expect(queued.map((q) => q.seq)).toEqual([...queued.map((q) => q.seq)].sort((a, b) => a - b));
    expect(queued.map((q) => q.op)).toEqual([
      { kind: 'delete', listId: 'L1', taskId: 'x' },
      { kind: 'delete', listId: 'L1', taskId: 'y' },
    ]);
  });

  test('snapshot identity changes only on writes and subscribers are told', async () => {
    const before = store.snapshot();
    expect(store.snapshot()).toBe(before);
    let calls = 0;
    store.subscribe(() => calls++);
    await store.commit({ notices: ['hello'] });
    expect(store.snapshot()).not.toBe(before);
    expect(store.snapshot().tasks).toBe(before.tasks);
    expect(calls).toBe(1);
  });

  test('hidden survives reopening the store', async () => {
    expect(store.snapshot().hidden).toEqual({});
    await store.commit({ meta: { hidden: { t1: 'b' } } });
    const reopened = await openStore(name);
    expect(reopened.snapshot().hidden).toEqual({ t1: 'b' });
  });

  test('a dismissed notice stays dismissed after a reopen', async () => {
    await store.commit({ notices: ['one', 'two'] });
    const [first] = store.snapshot().notices;
    await store.dismissNotice(first?.id ?? '');
    expect(store.snapshot().notices.map((n) => n.text)).toEqual(['two']);
    const reopened = await openStore(name);
    expect(reopened.snapshot().notices.map((n) => n.text)).toEqual(['two']);
  });

  test('renaming a task moves its entry and queued ops', async () => {
    await store.commit({ replaceEntries: { x: entry() } });
    await store.commit({ enqueue: [{ kind: 'delete', listId: 'L1', taskId: 'x' }] });
    await store.commit((s) => renameChange(s, 'x', 'real'));
    const s = store.snapshot();
    expect(s.tasks.map((t) => t.id)).toEqual(['real']);
    expect(Object.keys(s.entries)).toEqual(['real']);
    expect(await ops()).toEqual([{ kind: 'delete', listId: 'L1', taskId: 'real' }]);
  });
});

describe('steps', () => {
  const pos = (n: number) => String(n).padStart(20, '0');
  const titles = () => subtasksOf(store.snapshot().tasks, 'p').map((t) => t.title);

  beforeEach(async () => {
    await store.commit({
      putTasks: [
        task('p'),
        task('s1', { parent: 'p', position: pos(0) }),
        task('s2', { parent: 'p', position: pos(1) }),
        task('s3', { parent: 'p', position: pos(2) }),
      ],
    });
  });

  test('a new step goes last under its parent and queues a create with the parent', async () => {
    const id = await addSubtask(store, 'p', '  four  ', NOW);
    const s = store.snapshot();
    expect(id).toMatch(/^local-/);
    expect(s.tasks.find((t) => t.id === id)).toMatchObject({
      title: 'four',
      listId: 'L1',
      parent: 'p',
      position: pos(3),
    });
    expect(s.entries[id]).toBeUndefined();
    expect(subtasksOf(s.tasks, 'p').at(-1)?.id).toBe(id);
    expect(await ops()).toEqual([
      {
        kind: 'create',
        listId: 'L1',
        tempId: id,
        task: { title: 'four', parent: 'p', previous: 's3' },
      },
    ]);
  });

  test('steps typed quickly stay in the order they were typed', async () => {
    const a = addSubtask(store, 'p', 'one', NOW);
    const b = addSubtask(store, 'p', 'two', NOW);
    await Promise.all([a, b]);
    expect(titles()).toEqual(['s1', 's2', 's3', 'one', 'two']);
  });

  test('a blank step and a step under a subtask are refused', async () => {
    await expect(addSubtask(store, 'p', '   ', NOW)).rejects.toThrow('A step needs a title');
    await expect(addSubtask(store, 's1', 'nested', NOW)).rejects.toThrow(
      'A step cannot have steps of its own',
    );
    expect(await ops()).toEqual([]);
  });

  test('reordering a step queues parent and previous and shows the new order at once', async () => {
    await reorderSubtask(store, 's3', 's1', NOW);
    expect(titles()).toEqual(['s1', 's3', 's2']);
    expect(await ops()).toEqual([
      { kind: 'reorder', listId: 'L1', taskId: 's3', parent: 'p', previous: 's1' },
    ]);
  });

  test('a step can be moved to the top', async () => {
    await reorderSubtask(store, 's3', null, NOW);
    expect(titles()).toEqual(['s3', 's1', 's2']);
  });

  test('moving a step to where it already is queues nothing', async () => {
    await reorderSubtask(store, 's1', null, NOW);
    await reorderSubtask(store, 's2', 's1', NOW);
    expect(titles()).toEqual(['s1', 's2', 's3']);
    expect(await ops()).toEqual([]);
  });

  test('reordering refuses a parent task and a previous step from elsewhere', async () => {
    await store.commit({ putTasks: [task('q'), task('t1', { parent: 'q' })] });
    await expect(reorderSubtask(store, 'p', null, NOW)).rejects.toThrow(
      'Only a step can be reordered',
    );
    await expect(reorderSubtask(store, 's1', 't1', NOW)).rejects.toThrow('is not a step beside');
    expect(await ops()).toEqual([]);
  });

  test('renaming a parent also renames it in a queued step create and in a queued reorder', async () => {
    await addSubtask(store, 'p', 'four', NOW);
    await reorderSubtask(store, 's3', 's1', NOW);
    await store.commit((s) => renameChange(s, 'p', 'real'));
    const queued = await ops();
    expect(queued[0]).toMatchObject({ kind: 'create', task: { parent: 'real' } });
    expect(queued[1]).toMatchObject({ kind: 'reorder', parent: 'real', previous: 's1' });

    await store.commit((s) => renameChange(s, 's1', 'real-s1'));
    expect((await ops())[1]).toMatchObject({ previous: 'real-s1' });
  });

  test('renaming a step also renames it where a queued create names it as previous', async () => {
    const first = await addSubtask(store, 'p', 'four', NOW);
    await addSubtask(store, 'p', 'five', NOW);
    await store.commit((s) => renameChange(s, first, 'real-four'));
    expect((await ops())[1]).toMatchObject({ task: { parent: 'p', previous: 'real-four' } });
  });
});

describe('moveCardsToBottom', () => {
  const seed = async (
    tasks: ReturnType<typeof task>[],
    entries: Record<string, ReturnType<typeof entry>>,
  ) => {
    await store.commit({
      replaceRemote: { lists: [{ id: 'L1', title: 'One' }], tasks },
      replaceEntries: entries,
    });
  };
  const order = (column: string) =>
    Object.entries(store.snapshot().entries)
      .filter(([, e]) => e.column === column)
      .sort(([, a], [, b]) => a.rank - b.rank)
      .map(([id]) => id);

  test('cards from two columns land at the bottom of Next in their previous order, in one save', async () => {
    await seed([task('a'), task('b'), task('c'), task('n')], {
      a: entry({ column: 'Backlog', rank: 1 }),
      b: entry({ column: 'Backlog', rank: 2 }),
      c: entry({ column: 'Doing', openColumn: 'Doing', rank: 1 }),
      n: entry({ column: 'Next', openColumn: 'Next', rank: 1 }),
    });
    let saves = 0;
    store.subscribe(() => saves++);
    await moveCardsToBottom(store, ['c', 'a', 'b'], 'Next', NOW);
    expect(order('Next')).toEqual(['n', 'a', 'b', 'c']);
    expect(saves).toBe(1);
    expect(store.snapshot().entries.a).toMatchObject({ openColumn: 'Next', updatedAt: NOW });
  });

  test('a card already in the target column stays where it is', async () => {
    await seed([task('a'), task('n1'), task('n2')], {
      a: entry({ column: 'Backlog', rank: 1 }),
      n1: entry({ column: 'Next', openColumn: 'Next', rank: 1 }),
      n2: entry({ column: 'Next', openColumn: 'Next', rank: 2 }),
    });
    await moveCardsToBottom(store, ['n1', 'a'], 'Next', NOW);
    expect(order('Next')).toEqual(['n1', 'n2', 'a']);
    expect(store.snapshot().entries.n1?.updatedAt).not.toBe(NOW);
  });

  test('moving many into Done completes each, clears each pin and queues one patch per card', async () => {
    await seed([task('a'), task('b')], {
      a: entry({ column: 'Backlog', rank: 1, pinned: true }),
      b: entry({ column: 'Doing', openColumn: 'Doing', rank: 1, pinned: true }),
    });
    await moveCardsToBottom(store, ['a', 'b'], 'Done', NOW);
    const s = store.snapshot();
    expect(s.entries.a).toMatchObject({ column: 'Done', openColumn: 'Backlog', pinned: false });
    expect(s.entries.b).toMatchObject({ column: 'Done', openColumn: 'Doing', pinned: false });
    expect(
      s.tasks
        .filter((t) => t.completed)
        .map((t) => t.id)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(await ops()).toEqual([
      {
        kind: 'patch',
        listId: 'L1',
        taskId: 'a',
        set: { completed: true },
        base: { completed: false },
      },
      {
        kind: 'patch',
        listId: 'L1',
        taskId: 'b',
        set: { completed: true },
        base: { completed: false },
      },
    ]);
  });

  test('moving many out of Done reopens each and queues completed:false once per card', async () => {
    await seed(
      [
        task('a', { completed: true, completedAt: OLD_DONE }),
        task('b', { completed: true, completedAt: OLD_DONE }),
        task('w'),
      ],
      {
        a: entry({ column: 'Done', openColumn: 'Backlog', rank: 1 }),
        b: entry({ column: 'Done', openColumn: 'Doing', rank: 2 }),
        w: entry({ column: 'Doing', openColumn: 'Doing', rank: 5 }),
      },
    );
    await moveCardsToBottom(store, ['a', 'b'], 'Doing', NOW);
    expect(order('Doing')).toEqual(['w', 'a', 'b']);
    expect(store.snapshot().tasks.some((t) => t.completed)).toBe(false);
    expect(
      (await ops()).map((o) => (o.kind === 'patch' ? `${o.taskId}:${o.set.completed}` : o.kind)),
    ).toEqual(['a:false', 'b:false']);
  });

  test('cards leaving Done keep the order Done shows them in, newest first', async () => {
    await seed(
      [
        task('old', { completed: true, completedAt: '2026-11-15T09:00:00Z' }),
        task('new', { completed: true, completedAt: '2026-11-16T09:00:00Z' }),
      ],
      {
        // Ranks left over from different source columns say nothing about Done's order.
        old: entry({ column: 'Done', openColumn: 'Backlog', rank: 1 }),
        new: entry({ column: 'Done', openColumn: 'Doing', rank: 5 }),
      },
    );
    await moveCardsToBottom(store, ['old', 'new'], 'Next', NOW);
    expect(order('Next')).toEqual(['new', 'old']);
  });

  test('an unknown or deleted id in the selection is skipped and the rest still move', async () => {
    await seed([task('a')], { a: entry({ column: 'Backlog', rank: 1 }) });
    await moveCardsToBottom(store, ['gone', 'a'], 'Next', NOW);
    expect(order('Next')).toEqual(['a']);
  });

  test('a temporary id renamed by a replay is resolved', async () => {
    await seed([task('a')], { a: entry({ column: 'Backlog', rank: 1 }) });
    await store.commit((s) => renameChange(s, 'a', 'real-a'));
    await moveCardsToBottom(store, ['a'], 'Next', NOW);
    expect(order('Next')).toEqual(['real-a']);
  });

  test('nothing to move saves nothing', async () => {
    await seed([task('n')], { n: entry({ column: 'Next', openColumn: 'Next', rank: 1 }) });
    let saves = 0;
    store.subscribe(() => saves++);
    await moveCardsToBottom(store, ['n', 'gone'], 'Next', NOW);
    expect(saves).toBe(0);
    expect(await ops()).toEqual([]);
  });
});

test('entry priority and unknown fields survive a store round trip', async () => {
  const e = { ...entry({ priority: 'high' }), extra: { colour: 'teal' } };
  await store.commit({ entries: { x: e } });
  const reopened = await openStore(name);
  expect(reopened.snapshot().entries.x).toEqual(e);
});

describe('across accounts', () => {
  const others = {
    x2: entry({ column: 'Next', openColumn: 'Next', rank: 1024 }),
    y2: entry({ column: 'Next', openColumn: 'Next', rank: 2048 }),
  };

  beforeEach(async () => {
    await store.commit({
      putTasks: [task('a'), task('b')],
      replaceEntries: { a: entry({ rank: 1 }), b: entry({ rank: 2 }) },
    });
  });

  test("a drop between another account's cards takes a rank between them", async () => {
    const foreign = await moveCard(store, 'a', 'Next', 'x2', NOW, others);
    const rank = store.snapshot().entries.a?.rank ?? 0;
    expect(rank).toBeGreaterThan(1024);
    expect(rank).toBeLessThan(2048);
    expect(foreign).toEqual({});
  });

  test("a rebalance returns the other account's new ranks", async () => {
    const tight = {
      x2: entry({ column: 'Next', openColumn: 'Next', rank: 1 }),
      y2: entry({ column: 'Next', openColumn: 'Next', rank: 1 + 1e-7 }),
    };
    const foreign = await moveCard(store, 'a', 'Next', 'x2', NOW, tight);
    expect(Object.keys(foreign).sort()).toEqual(['x2', 'y2']);
    expect(foreign.x2).toMatchObject({ updatedAt: NOW });
    expect(foreign.y2).toMatchObject({ updatedAt: NOW });
    const rank = store.snapshot().entries.a?.rank ?? 0;
    expect(rank).toBeGreaterThan(foreign.x2?.rank ?? 0);
    expect(rank).toBeLessThan(foreign.y2?.rank ?? 0);
    expect(store.snapshot().entries.x2).toBeUndefined();
    expect(store.snapshot().entries.y2).toBeUndefined();
  });

  test("moving several cards to the bottom lands below the other account's bottom card", async () => {
    await moveCardsToBottom(store, ['b', 'a'], 'Next', NOW, others);
    const { entries } = store.snapshot();
    expect(entries.a?.rank).toBeGreaterThan(2048);
    expect(entries.b?.rank).toBeGreaterThan(entries.a?.rank ?? 0);
  });

  test("moving one card to the bottom lands below the other account's bottom card", async () => {
    await moveCardToBottom(store, 'a', 'Next', NOW, others);
    expect(store.snapshot().entries.a?.rank).toBeGreaterThan(2048);
  });

  test("a quick add goes below the other account's Backlog", async () => {
    const id = await addTask(store, { listId: 'L1', title: 'New', pinned: false }, NOW, {
      z: entry({ rank: 9000 }),
    });
    expect(store.snapshot().entries[id]?.rank).toBeGreaterThan(9000);
  });

  test("reopening lands below the other account's cards in the open column", async () => {
    await store.commit({
      putTasks: [task('a', { completed: true, completedAt: OLD_DONE })],
      entries: { a: entry({ column: 'Done', openColumn: 'Next' }) },
    });
    await setCompleted(store, 'a', false, NOW, others);
    expect(store.snapshot().entries.a).toMatchObject({ column: 'Next' });
    expect(store.snapshot().entries.a?.rank).toBeGreaterThan(2048);
  });

  test('putEntries writes only ids this store already has', async () => {
    await putEntries(store, {
      a: entry({ rank: 77, updatedAt: NOW }),
      x2: entry({ updatedAt: NOW }),
    });
    const { entries } = store.snapshot();
    expect(entries.a).toMatchObject({ rank: 77, updatedAt: NOW });
    expect(entries.x2).toBeUndefined();
  });

  test('a priority set after the foreign ranks were computed survives putEntries', async () => {
    const foreign = { a: { ...entry({ rank: 77, updatedAt: NOW }), extra: { stale: true } } };
    await setPriority(store, 'a', 'high', '2026-11-17T10:00:01Z');
    await putEntries(store, foreign);
    expect(store.snapshot().entries.a).toEqual({
      ...entry({ rank: 77, updatedAt: NOW }),
      priority: 'high',
    });
  });
});

describe('copyToAccount', () => {
  const pos = (n: number) => String(n).padStart(20, '0');
  let target: Store;

  beforeEach(async () => {
    target = await openStore(`test-${crypto.randomUUID()}`);
    await target.commit({ replaceRemote: { lists: [{ id: 'T1', title: 'Theirs' }], tasks: [] } });
    await store.commit({
      putTasks: [
        task('p', {
          title: 'Parent',
          notes: 'Some notes',
          due: '2026-12-01',
          completed: true,
          completedAt: OLD_DONE,
          updated: '2026-11-15T00:00:00Z',
        }),
        task('s2', {
          parent: 'p',
          title: 'Second',
          position: pos(1),
          updated: '2026-11-15T02:00:00Z',
        }),
        task('s1', {
          parent: 'p',
          title: 'First',
          position: pos(0),
          completed: true,
          completedAt: OLD_DONE,
          updated: '2026-11-15T01:00:00Z',
        }),
      ],
      entries: {
        p: entry({
          column: 'Done',
          openColumn: 'Doing',
          rank: 3000,
          priority: 'high',
          extra: { future: 1 },
        }),
      },
    });
  });

  test('copyToAccount copies steps in order with their done state', async () => {
    await copyToAccount(store, target, 'acc-a', 'acc-b', 'p', 'T1', NOW);
    const t = target.snapshot();
    const queued = t.queued.map((q) => q.op);
    const copy = t.tasks.find((x) => x.parent === null);
    const first = t.tasks.find((x) => x.title === 'First');
    const second = t.tasks.find((x) => x.title === 'Second');
    if (!copy || !first || !second) throw new Error('copy missing');
    for (const id of [copy.id, first.id, second.id]) expect(id).toMatch(/^local-/);
    expect(first.parent).toBe(copy.id);
    expect(second.parent).toBe(copy.id);
    expect(copy).toMatchObject({ listId: 'T1', completed: true, updated: NOW });
    expect(subtasksOf(t.tasks, copy.id).map((x) => x.title)).toEqual(['First', 'Second']);

    const done = { set: { completed: true }, base: { completed: false } };
    expect(queued).toEqual([
      {
        kind: 'create',
        listId: 'T1',
        tempId: copy.id,
        task: { title: 'Parent', notes: 'Some notes', due: '2026-12-01' },
      },
      { kind: 'patch', listId: 'T1', taskId: copy.id, ...done },
      { kind: 'create', listId: 'T1', tempId: first.id, task: { title: 'First', parent: copy.id } },
      { kind: 'patch', listId: 'T1', taskId: first.id, ...done },
      {
        kind: 'create',
        listId: 'T1',
        tempId: second.id,
        task: { title: 'Second', parent: copy.id, previous: first.id },
      },
      {
        kind: 'handoff',
        listId: 'T1',
        taskId: copy.id,
        source: { accountId: 'acc-a', listId: 'L1', taskId: 'p', title: 'Parent' },
        fingerprint: {
          updated: '2026-11-15T00:00:00Z',
          steps: { s1: '2026-11-15T01:00:00Z', s2: '2026-11-15T02:00:00Z' },
        },
      },
    ]);
    expect(t.entries[copy.id]).toEqual({
      column: 'Done',
      openColumn: 'Doing',
      rank: 3000,
      pinned: false,
      priority: 'high',
      extra: { future: 1 },
      updatedAt: NOW,
    });
    expect(store.snapshot().hidden).toEqual({ p: 'acc-b' });
  });

  test('copyToAccount refuses while the task has unsent changes', async () => {
    await store.commit({
      enqueue: [
        {
          kind: 'patch',
          listId: 'L1',
          taskId: 's2',
          set: { title: 'X' },
          base: { title: 'Second' },
        },
      ],
    });
    const before = { source: store.snapshot(), target: target.snapshot() };
    await expect(copyToAccount(store, target, 'acc-a', 'acc-b', 'p', 'T1', NOW)).rejects.toThrow();
    expect(store.snapshot()).toBe(before.source);
    expect(target.snapshot()).toBe(before.target);
  });

  test('copyToAccount refuses a step', async () => {
    await expect(copyToAccount(store, target, 'acc-a', 'acc-b', 's1', 'T1', NOW)).rejects.toThrow();
    expect(target.snapshot().queued).toEqual([]);
    expect(store.snapshot().hidden).toEqual({});
  });
});

describe('hasUnsent', () => {
  test('sees ops on the task, on its steps, and creates or reorders naming it as parent', async () => {
    await store.commit({ putTasks: [task('p'), task('s', { parent: 'p' })] });
    const withOp = (op: Op) => ({ ...store.snapshot(), queued: [{ seq: 1, op }] });
    expect(hasUnsent(store.snapshot(), 'p')).toBe(false);
    expect(hasUnsent(withOp({ kind: 'delete', listId: 'L1', taskId: 'p' }), 'p')).toBe(true);
    expect(hasUnsent(withOp({ kind: 'delete', listId: 'L1', taskId: 's' }), 'p')).toBe(true);
    expect(
      hasUnsent(
        withOp({
          kind: 'create',
          listId: 'L1',
          tempId: 'local-n',
          task: { title: 'n', parent: 'p' },
        }),
        'p',
      ),
    ).toBe(true);
    expect(
      hasUnsent(
        withOp({ kind: 'reorder', listId: 'L1', taskId: 'local-n', parent: 'p', previous: null }),
        'p',
      ),
    ).toBe(true);
    expect(hasUnsent(withOp({ kind: 'delete', listId: 'L1', taskId: 'x' }), 'p')).toBe(false);
  });
});
