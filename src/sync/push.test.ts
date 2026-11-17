import { beforeEach, expect, test } from 'vitest';
import { subtasksOf } from '../domain/subtasks';
import { entry, task } from '../domain/test-fixtures';
import { AuthError, HttpError, NotFoundError, OfflineError } from '../google/api';
import { createFakeGoogle, type FakeGoogle, fakePosition } from '../google/fake';
import { type Op, openStore, type Store } from '../store/db';
import {
  addSubtask,
  addTask,
  deleteTask,
  editTask,
  moveCard,
  moveToList,
  reorderSubtask,
} from '../store/edits';
import { replay } from './push';

const NOW = '2026-11-17T10:00:00Z';
const LISTS = [
  { id: 'L1', title: 'One' },
  { id: 'L2', title: 'Two' },
];
let store: Store;
let google: FakeGoogle;

beforeEach(async () => {
  store = await openStore(`test-${crypto.randomUUID()}`);
  const tasks = ['x', 'y', 'z'].map((id) => task(id));
  await store.commit({ replaceRemote: { lists: LISTS, tasks: tasks } });
  google = createFakeGoogle({ lists: LISTS, tasks });
});

test('edits to a task still waiting to be created follow it to its real ID', async () => {
  const id = await addTask(store, { listId: 'L1', title: 'New', pinned: false }, NOW);
  await editTask(store, id, { notes: 'n' });
  await moveCard(store, id, 'Next', null, NOW);
  expect(await replay(google, store)).toBe('done');
  const real = [...google.tasks.values()].find((t) => t.title === 'New') ?? task('missing');
  expect(real.notes).toBe('n');
  expect(store.snapshot().entries[real.id]?.column).toBe('Next');
  expect(store.snapshot().entries[id]).toBeUndefined();
  expect(store.snapshot().tasks.find((t) => t.id === real.id)?.notes).toBe('n');
});

test('an edit through the old temporary ID reaches the real task after the rename', async () => {
  const id = await addTask(store, { listId: 'L1', title: 'New', pinned: false }, NOW);
  expect(await replay(google, store)).toBe('done');
  const real = [...google.tasks.values()].find((t) => t.title === 'New') ?? task('missing');
  expect(store.snapshot().renamed[id]).toBe(real.id);
  await editTask(store, id, { notes: 'late' });
  await moveCard(store, id, 'Next', null, NOW);
  expect(store.snapshot().tasks.find((t) => t.id === real.id)?.notes).toBe('late');
  expect(store.snapshot().entries[real.id]?.column).toBe('Next');
  expect(await replay(google, store)).toBe('done');
  expect(google.tasks.get(real.id)?.notes).toBe('late');
});

test('deleting a task before its create is sent never reaches Google', async () => {
  const id = await addTask(store, { listId: 'L1', title: 'New', pinned: false }, NOW);
  await editTask(store, id, { notes: 'n' });
  await deleteTask(store, id);
  expect(await replay(google, store)).toBe('done');
  expect(google.calls).toEqual([]);
  expect(store.snapshot().queued).toEqual([]);
});

test('an edit to a task deleted elsewhere is dropped with a notice', async () => {
  await editTask(store, 'x', { title: 'Renamed' });
  await editTask(store, 'x', { notes: 'later' });
  google.tasks.delete('x');
  expect(await replay(google, store)).toBe('done');
  expect(store.snapshot().queued).toEqual([]);
  expect(store.snapshot().tasks.map((t) => t.id)).not.toContain('x');
  expect(store.snapshot().notices).toHaveLength(1);
  expect(store.snapshot().notices[0]?.text).toBe(
    '“Renamed” was deleted elsewhere, so your change was dropped.',
  );
});

test('a field changed elsewhere is kept and the local change is reported, other fields still apply', async () => {
  await editTask(store, 'x', { title: 'Mine', notes: 'local notes' });
  google.tasks.set('x', task('x', { title: 'Theirs' }));
  await replay(google, store);
  expect(google.tasks.get('x')).toMatchObject({ title: 'Theirs', notes: 'local notes' });
  expect(store.snapshot().notices[0]?.text).toBe(
    "“Theirs”: your change to title wasn't applied because it was changed elsewhere. Your version: Mine",
  );
  expect(store.snapshot().tasks.find((t) => t.id === 'x')).toMatchObject({
    title: 'Theirs',
    notes: 'local notes',
  });
});

test('nothing is sent when every field conflicts', async () => {
  await editTask(store, 'x', { title: 'Mine' });
  google.tasks.set('x', task('x', { title: 'Theirs' }));
  await replay(google, store);
  expect(google.calls.map((c) => c.method)).toEqual(['getTask']);
});

test('token expiry mid-replay stops and keeps the rest in order', async () => {
  await editTask(store, 'x', { title: 'one' });
  await editTask(store, 'y', { title: 'two' });
  await editTask(store, 'z', { title: 'three' });
  google.failOn('getTask', new AuthError(), { after: 1 });
  expect(await replay(google, store)).toBe('auth');
  expect(store.snapshot().queued.map((q) => (q.op as { taskId: string }).taskId)).toEqual([
    'y',
    'z',
  ]);
});

test('going offline leaves the op at the head and changes nothing locally', async () => {
  await editTask(store, 'x', { title: 'one' });
  google.failOn('getTask', new OfflineError());
  expect(await replay(google, store)).toBe('offline');
  expect(store.snapshot().queued).toHaveLength(1);
  expect(store.snapshot().notices).toEqual([]);
});

test('a later local edit survives Google confirming an earlier one', async () => {
  await editTask(store, 'x', { title: 'one' });
  google.onAfter('patchTask', () => {
    void editTask(store, 'x', { title: 'two' });
  });
  await replay(google, store);
  expect(google.tasks.get('x')?.title).toBe('two');
  expect(store.snapshot().tasks.find((t) => t.id === 'x')?.title).toBe('two');
});

test('deleting a task that is already gone counts as done', async () => {
  await deleteTask(store, 'x');
  google.tasks.delete('x');
  expect(await replay(google, store)).toBe('done');
  expect(store.snapshot().notices).toEqual([]);
});

test('moving a task to another list is sent and the board card stays', async () => {
  await store.commit({ replaceEntries: { x: entry({ column: 'Next', openColumn: 'Next' }) } });
  await moveToList(store, 'x', 'L2');
  expect(await replay(google, store)).toBe('done');
  expect(google.tasks.get('x')?.listId).toBe('L2');
  expect(store.snapshot().entries.x?.column).toBe('Next');
});

test('a create whose response was lost is adopted on the next replay, not sent twice', async () => {
  const id = await addTask(store, { listId: 'L1', title: 'Once', pinned: false }, NOW);
  google.onAfter('insertTask', () => {
    throw new OfflineError();
  });
  expect(await replay(google, store)).toBe('offline');
  expect(await replay(google, store)).toBe('done');
  const made = [...google.tasks.values()].filter((t) => t.title === 'Once');
  expect(made).toHaveLength(1);
  expect(store.snapshot().tasks.map((t) => t.id)).toContain(made[0]?.id);
  expect(store.snapshot().tasks.map((t) => t.id)).not.toContain(id);
});

test('an edit made while the create is in flight targets the real ID', async () => {
  const id = await addTask(store, { listId: 'L1', title: 'New', pinned: false }, NOW);
  google.onAfter('insertTask', () => {
    void editTask(store, id, { notes: 'late' });
  });
  expect(await replay(google, store)).toBe('done');
  const real = [...google.tasks.values()].find((t) => t.title === 'New');
  expect(real?.notes).toBe('late');
  expect(store.snapshot().queued).toEqual([]);
});

test('a lone create replaces the local copy with Google’s task', async () => {
  const id = await addTask(store, { listId: 'L1', title: 'Solo', pinned: true }, NOW);
  expect(await replay(google, store)).toBe('done');
  const real = [...google.tasks.values()].find((t) => t.title === 'Solo');
  const s = store.snapshot();
  expect(s.tasks.find((t) => t.id === real?.id)).toEqual(real);
  expect(s.tasks.find((t) => t.id === id)).toBeUndefined();
  expect(s.entries[real?.id ?? '']?.pinned).toBe(true);
});

test('a create for a list that no longer exists is dropped with a notice', async () => {
  const id = await addTask(store, { listId: 'L9', title: 'Orphan', pinned: false }, NOW);
  expect(await replay(google, store)).toBe('done');
  expect(store.snapshot().queued).toEqual([]);
  expect(store.snapshot().tasks.find((t) => t.id === id)).toBeUndefined();
  expect(store.snapshot().entries[id]).toBeUndefined();
  expect(store.snapshot().notices[0]?.text).toBe(
    "“Orphan” couldn't be added because its list no longer exists.",
  );
});

test('a move whose response was lost is settled, not reported as a deletion', async () => {
  await store.commit({ replaceEntries: { x: entry({ column: 'Next', openColumn: 'Next' }) } });
  await moveToList(store, 'x', 'L2');
  google.tasks.set('x', task('x', { listId: 'L2' }));
  expect(await replay(google, store)).toBe('done');
  const s = store.snapshot();
  expect(s.notices).toEqual([]);
  expect(s.entries.x?.column).toBe('Next');
  expect(s.tasks.find((t) => t.id === 'x')?.listId).toBe('L2');
});

test('a move to a deleted list is dropped and the task goes back to its old list', async () => {
  await store.commit({ replaceEntries: { x: entry({ column: 'Next', openColumn: 'Next' }) } });
  await moveToList(store, 'x', 'L2');
  google.lists.splice(1, 1);
  expect(await replay(google, store)).toBe('done');
  const s = store.snapshot();
  expect(store.snapshot().queued).toEqual([]);
  expect(s.tasks.find((t) => t.id === 'x')?.listId).toBe('L1');
  expect(s.entries.x?.column).toBe('Next');
  expect(s.notices[0]?.text).toBe("“x” couldn't be moved because the list no longer exists.");
});

test('a permanent 4xx drops the op with a notice and replay carries on', async () => {
  await editTask(store, 'x', { title: 'Renamed' });
  await editTask(store, 'y', { title: 'Other' });
  google.failOn('patchTask', new HttpError(400, 'bad'), { times: 1 });
  expect(await replay(google, store)).toBe('done');
  expect(store.snapshot().queued).toEqual([]);
  expect(store.snapshot().notices.map((n) => n.text)).toEqual([
    'Google refused a change to “Renamed” (error 400), so it was dropped.',
  ]);
  expect(google.tasks.get('y')?.title).toBe('Other');
});

test.each([500, 403, 408, 429])(
  'a %i keeps the op at the head and reports an error',
  async (status) => {
    await editTask(store, 'x', { title: 'Renamed' });
    google.failOn('patchTask', new HttpError(status, 'later'));
    expect(await replay(google, store)).toBe('error');
    expect(store.snapshot().queued).toHaveLength(1);
    expect(store.snapshot().notices).toEqual([]);
  },
);

test('a create that may have reached Google is adopted and then deleted, not dropped', async () => {
  const id = await addTask(store, { listId: 'L1', title: 'Once', pinned: false }, NOW);
  google.onAfter('insertTask', () => {
    throw new OfflineError();
  });
  expect(await replay(google, store)).toBe('offline');
  await deleteTask(store, id);
  expect(await replay(google, store)).toBe('done');
  expect([...google.tasks.values()].filter((t) => t.title === 'Once')).toEqual([]);
  expect(store.snapshot().queued).toEqual([]);
});

test('edits to a subtask follow it back when its parent’s move to a deleted list is dropped', async () => {
  const sub = task('sub', { parent: 'x' });
  google.tasks.set('sub', { ...sub });
  await store.commit({ putTasks: [sub] });
  await moveToList(store, 'x', 'L2');
  await editTask(store, 'sub', { notes: 'kept' });
  google.lists.splice(1, 1);
  expect(await replay(google, store)).toBe('done');
  expect(google.tasks.get('sub')?.notes).toBe('kept');
  expect(store.snapshot().notices.map((n) => n.text)).toEqual([
    "“x” couldn't be moved because the list no longer exists.",
  ]);
});

test('a step added after its parent’s move to a deleted list is created in the old list', async () => {
  await moveToList(store, 'x', 'L2');
  await addSubtask(store, 'x', 'Step', NOW);
  google.lists.splice(1, 1);
  expect(await replay(google, store)).toBe('done');
  const step = [...google.tasks.values()].find((t) => t.title === 'Step');
  expect(step).toMatchObject({ listId: 'L1', parent: 'x' });
  expect(store.snapshot().notices.map((n) => n.text)).toEqual([
    "“x” couldn't be moved because the list no longer exists.",
  ]);
});

test('a move of a task deleted elsewhere drops it with a notice naming it', async () => {
  await store.commit({ replaceEntries: { x: entry({ column: 'Next', openColumn: 'Next' }) } });
  await moveToList(store, 'x', 'L2');
  google.tasks.delete('x');
  expect(await replay(google, store)).toBe('done');
  const s = store.snapshot();
  expect(s.tasks.find((t) => t.id === 'x')).toBeUndefined();
  expect(s.entries.x).toBeUndefined();
  expect(s.notices.map((n) => n.text)).toEqual([
    '“x” was deleted elsewhere, so your change was dropped.',
  ]);
});

// Seeds steps under x, in this order, both locally and in Google.
async function seedSteps(...ids: string[]) {
  const steps = ids.map((id, i) => task(id, { parent: 'x', position: fakePosition(i) }));
  for (const t of steps) google.tasks.set(t.id, { ...t });
  await store.commit({ putTasks: steps });
}

const stepsInGoogle = (parent: string) =>
  [...google.tasks.values()]
    .filter((t) => t.parent === parent)
    .sort((a, b) => a.position.localeCompare(b.position))
    .map((t) => t.title);

const findInGoogle = (title: string) =>
  [...google.tasks.values()].find((t) => t.title === title) ?? task('missing');

test('a step added offline under a new task ends up under its real ID in Google', async () => {
  const id = await addTask(store, { listId: 'L1', title: 'New', pinned: false }, NOW);
  const stepId = await addSubtask(store, id, 'Step', NOW);
  expect(await replay(google, store)).toBe('done');
  const parent = findInGoogle('New');
  expect(findInGoogle('Step').parent).toBe(parent.id);
  const s = store.snapshot();
  expect(s.queued).toEqual([]);
  expect(s.tasks.find((t) => t.title === 'Step')?.parent).toBe(parent.id);
  expect(s.tasks.find((t) => t.id === stepId)).toBeUndefined();
});

test('a step create whose response was lost is adopted under the right parent', async () => {
  await addSubtask(store, 'x', 'Once', NOW);
  google.onAfter('insertTask', () => {
    throw new OfflineError();
  });
  expect(await replay(google, store)).toBe('offline');
  // A top-level task with the same title, made elsewhere just before, must not be adopted.
  google.tasks.set(
    'decoy',
    task('decoy', { title: 'Once', updated: new Date(Date.now() - 30_000).toISOString() }),
  );
  expect(await replay(google, store)).toBe('done');
  const steps = [...google.tasks.values()].filter((t) => t.title === 'Once' && t.parent === 'x');
  expect(steps).toHaveLength(1);
  const local = store.snapshot().tasks.filter((t) => t.title === 'Once');
  expect(local.map((t) => t.id)).toEqual([steps[0]?.id]);
  expect(local[0]?.parent).toBe('x');
});

test('a reorder replays with the right parent and previous after the parent was renamed', async () => {
  const id = await addTask(store, { listId: 'L1', title: 'New', pinned: false }, NOW);
  const a = await addSubtask(store, id, 'A', NOW);
  await addSubtask(store, id, 'B', NOW);
  await addSubtask(store, id, 'C', NOW);
  const b = store.snapshot().tasks.find((t) => t.title === 'B')?.id ?? '';
  await reorderSubtask(store, a, b, NOW);
  expect(await replay(google, store)).toBe('done');
  const parent = findInGoogle('New');
  expect(stepsInGoogle(parent.id)).toEqual(['B', 'A', 'C']);
  const last = google.calls.filter((c) => c.method === 'reorderTask').at(-1);
  expect(last?.args).toEqual(['L1', findInGoogle('A').id, parent.id, findInGoogle('B').id]);
  expect(store.snapshot().queued).toEqual([]);
});

test('a reorder after a sibling deleted elsewhere lands after the nearest earlier sibling', async () => {
  await seedSteps('s1', 's2', 's3', 's4');
  await reorderSubtask(store, 's1', 's3', NOW);
  google.tasks.delete('s3');
  expect(await replay(google, store)).toBe('done');
  expect(stepsInGoogle('x')).toEqual(['s2', 's1', 's4']);
  expect(store.snapshot().queued).toEqual([]);
  expect(store.snapshot().notices).toEqual([]);
});

test('a reorder of a step deleted elsewhere is dropped with a notice', async () => {
  await seedSteps('s1', 's2');
  await reorderSubtask(store, 's1', 's2', NOW);
  google.tasks.delete('s1');
  expect(await replay(google, store)).toBe('done');
  const s = store.snapshot();
  expect(s.queued).toEqual([]);
  expect(s.tasks.find((t) => t.id === 's1')).toBeUndefined();
  expect(s.notices.map((n) => n.text)).toEqual([
    '“s1” was deleted elsewhere, so your change was dropped.',
  ]);
});

test('a step whose parent was deleted elsewhere is dropped with a notice, and sync carries on', async () => {
  const stepId = await addSubtask(store, 'x', 'Step', NOW);
  await addSubtask(store, 'x', 'Another', NOW);
  await editTask(store, 'y', { title: 'Later' });
  google.tasks.delete('x');
  expect(await replay(google, store)).toBe('done');
  const s = store.snapshot();
  expect(s.queued).toEqual([]);
  expect(s.tasks.find((t) => t.id === stepId)).toBeUndefined();
  expect(s.tasks.find((t) => t.id === 'x')).toBeUndefined();
  expect(s.notices.map((n) => n.text)).toEqual([
    '“x” was deleted elsewhere, so your change was dropped.',
  ]);
  expect(google.tasks.get('y')?.title).toBe('Later');
});

test('a step create whose previous step was deleted elsewhere lands after the nearest earlier one', async () => {
  await seedSteps('s1', 's2');
  await addSubtask(store, 'x', 'New', NOW);
  google.tasks.delete('s2');
  expect(await replay(google, store)).toBe('done');
  expect(stepsInGoogle('x')).toEqual(['s1', 'New']);
  expect(store.snapshot().queued).toEqual([]);
  expect(store.snapshot().notices).toEqual([]);
});

test('deleting a task drops its unsent step creates without calling Google', async () => {
  const stepId = await addSubtask(store, 'x', 'Step', NOW);
  await editTask(store, stepId, { notes: 'n' });
  await deleteTask(store, 'x');
  expect(await replay(google, store)).toBe('done');
  expect(google.calls.map((c) => c.method)).toEqual(['deleteTask']);
  expect(store.snapshot().queued).toEqual([]);
});

test('a new task deleted before sync takes its steps and their reorders with it', async () => {
  const id = await addTask(store, { listId: 'L1', title: 'New', pinned: false }, NOW);
  const a = await addSubtask(store, id, 'A', NOW);
  const b = await addSubtask(store, id, 'B', NOW);
  await reorderSubtask(store, a, b, NOW);
  await deleteTask(store, id);
  expect(await replay(google, store)).toBe('done');
  expect(google.calls).toEqual([]);
  expect(store.snapshot().queued).toEqual([]);
});

test('a step added, reordered and deleted before sync never reaches Google', async () => {
  await seedSteps('s1');
  const id = await addSubtask(store, 'x', 'Gone', NOW);
  await reorderSubtask(store, id, null, NOW);
  await deleteTask(store, id);
  expect(await replay(google, store)).toBe('done');
  expect(google.calls).toEqual([]);
  expect(store.snapshot().queued).toEqual([]);
});

test('a create naming a cancelled step as previous falls back to the step before it', async () => {
  await seedSteps('s1');
  const a = await addSubtask(store, 'x', 'A', NOW);
  await addSubtask(store, 'x', 'B', NOW);
  await deleteTask(store, a);
  expect(await replay(google, store)).toBe('done');
  expect(
    google.calls.map((c) => [c.method, (c.args[1] as { previous?: string }).previous]),
  ).toEqual([['insertTask', 's1']]);
  expect(stepsInGoogle('x')).toEqual(['s1', 'B']);
});

test('a task deleted elsewhere takes its queued step creates with it', async () => {
  await editTask(store, 'x', { notes: 'n' });
  await addSubtask(store, 'x', 'Step', NOW);
  google.tasks.delete('x');
  expect(await replay(google, store)).toBe('done');
  expect(google.calls.some((c) => c.method === 'insertTask')).toBe(false);
  expect(store.snapshot().queued).toEqual([]);
  expect(store.snapshot().notices.map((n) => n.text)).toEqual([
    '“x” was deleted elsewhere, so your change was dropped.',
  ]);
});

test('a reorder naming a step deleted elsewhere as previous falls back without a retry', async () => {
  await seedSteps('s1', 's2', 's3');
  await editTask(store, 's2', { notes: 'n' });
  await reorderSubtask(store, 's1', 's2', NOW);
  google.tasks.delete('s2');
  expect(await replay(google, store)).toBe('done');
  expect(google.calls.filter((c) => c.method === 'reorderTask').map((c) => c.args)).toEqual([
    ['L1', 's1', 'x', null],
  ]);
  expect(stepsInGoogle('x')).toEqual(['s1', 's3']);
  expect(store.snapshot().notices).toHaveLength(1);
});

test('an op of an unknown kind stops replay with an error instead of looping', async () => {
  await store.commit({ enqueue: [{ kind: 'unknown' } as unknown as Op] });
  expect(await replay(google, store)).toBe('error');
});

const SPACING = 2 ** 30;

// Real Google positions are widely spaced, unlike the local renumbering.
async function seedSpacedSteps(...ids: string[]) {
  const tasks = [
    ...['x', 'y', 'z'].map((id) => task(id)),
    ...ids.map((id, i) => task(id, { parent: 'x', position: fakePosition(BigInt(i * SPACING)) })),
  ];
  google = createFakeGoogle({ lists: LISTS, tasks, positionSpacing: SPACING });
  await store.commit({ replaceRemote: { lists: LISTS, tasks } });
}

const localSteps = () => subtasksOf(store.snapshot().tasks, 'x').map((t) => t.title);

test('a reorder keeps the local step order once Google confirms it', async () => {
  await seedSpacedSteps('s1', 's2', 's3');
  await reorderSubtask(store, 's1', 's2', NOW);
  expect(await replay(google, store)).toBe('done');
  expect(stepsInGoogle('x')).toEqual(['s2', 's1', 's3']);
  expect(localSteps()).toEqual(['s2', 's1', 's3']);
});

test('editing a step after the steps were renumbered keeps it in place', async () => {
  await seedSpacedSteps('s1', 's2', 's3');
  await addSubtask(store, 'x', 'New', NOW);
  expect(await replay(google, store)).toBe('done');
  await editTask(store, 's2', { title: 'Two' });
  expect(await replay(google, store)).toBe('done');
  expect(localSteps()).toEqual(['s1', 'Two', 's3', 'New']);
});

test('a step create that misses again on its retry is dropped as deleted elsewhere', async () => {
  await seedSteps('s1');
  await addSubtask(store, 'x', 'Step', NOW);
  google.failOn('insertTask', new NotFoundError('gone'), { times: 2 });
  expect(await replay(google, store)).toBe('done');
  expect(store.snapshot().queued).toEqual([]);
  expect(store.snapshot().notices.map((n) => n.text)).toEqual([
    '“Step” was deleted elsewhere, so your change was dropped.',
  ]);
});

test('a reorder that misses again on its retry is dropped as deleted elsewhere', async () => {
  await seedSteps('s1', 's2');
  await reorderSubtask(store, 's1', 's2', NOW);
  google.failOn('reorderTask', new NotFoundError('gone'), { times: 2 });
  expect(await replay(google, store)).toBe('done');
  expect(store.snapshot().queued).toEqual([]);
  expect(store.snapshot().notices.map((n) => n.text)).toEqual([
    '“s1” was deleted elsewhere, so your change was dropped.',
  ]);
});

test('a refused create takes its queued steps with it', async () => {
  const id = await addTask(store, { listId: 'L1', title: 'New', pinned: false }, NOW);
  const a = await addSubtask(store, id, 'A', NOW);
  const b = await addSubtask(store, id, 'B', NOW);
  await reorderSubtask(store, a, b, NOW);
  google.failOn('insertTask', new HttpError(400, 'bad'), { times: 1 });
  expect(await replay(google, store)).toBe('done');
  expect(google.calls.map((c) => c.method)).toEqual(['insertTask']);
  expect(store.snapshot().queued).toEqual([]);
  expect(store.snapshot().notices.map((n) => n.text)).toEqual([
    'Google refused a change to “New” (error 400), so it was dropped.',
  ]);
});
