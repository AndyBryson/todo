import { beforeEach, expect, test } from 'vitest';
import { entry, task } from '../domain/test-fixtures';
import { AuthError, HttpError, OfflineError } from '../google/api';
import { createFakeGoogle, type FakeGoogle } from '../google/fake';
import { openStore, type Store } from '../store/db';
import { addTask, deleteTask, editTask, moveCard, moveToList } from '../store/edits';
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
  await store.replaceRemote(LISTS, tasks);
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
  expect(await store.queue()).toEqual([]);
});

test('an edit to a task deleted elsewhere is dropped with a notice', async () => {
  await editTask(store, 'x', { title: 'Renamed' });
  await editTask(store, 'x', { notes: 'later' });
  google.tasks.delete('x');
  expect(await replay(google, store)).toBe('done');
  expect(await store.queue()).toEqual([]);
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
  expect((await store.queue()).map((q) => (q.op as { taskId: string }).taskId)).toEqual(['y', 'z']);
});

test('going offline leaves the op at the head and changes nothing locally', async () => {
  await editTask(store, 'x', { title: 'one' });
  google.failOn('getTask', new OfflineError());
  expect(await replay(google, store)).toBe('offline');
  expect(await store.queue()).toHaveLength(1);
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
  await store.setEntries({ x: entry({ column: 'Next', openColumn: 'Next' }) });
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
  expect(await store.queue()).toEqual([]);
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
  expect(await store.queue()).toEqual([]);
  expect(store.snapshot().tasks.find((t) => t.id === id)).toBeUndefined();
  expect(store.snapshot().entries[id]).toBeUndefined();
  expect(store.snapshot().notices[0]?.text).toBe(
    "“Orphan” couldn't be added because its list no longer exists.",
  );
});

test('a move whose response was lost is settled, not reported as a deletion', async () => {
  await store.setEntries({ x: entry({ column: 'Next', openColumn: 'Next' }) });
  await moveToList(store, 'x', 'L2');
  google.tasks.set('x', task('x', { listId: 'L2' }));
  expect(await replay(google, store)).toBe('done');
  const s = store.snapshot();
  expect(s.notices).toEqual([]);
  expect(s.entries.x?.column).toBe('Next');
  expect(s.tasks.find((t) => t.id === 'x')?.listId).toBe('L2');
});

test('a move to a deleted list is dropped and the task goes back to its old list', async () => {
  await store.setEntries({ x: entry({ column: 'Next', openColumn: 'Next' }) });
  await moveToList(store, 'x', 'L2');
  google.lists.splice(1, 1);
  expect(await replay(google, store)).toBe('done');
  const s = store.snapshot();
  expect(await store.queue()).toEqual([]);
  expect(s.tasks.find((t) => t.id === 'x')?.listId).toBe('L1');
  expect(s.entries.x?.column).toBe('Next');
  expect(s.notices[0]?.text).toBe("“x” couldn't be moved because the list no longer exists.");
});

test('a permanent 4xx drops the op with a notice and replay carries on', async () => {
  await editTask(store, 'x', { title: 'Renamed' });
  await editTask(store, 'y', { title: 'Other' });
  google.failOn('patchTask', new HttpError(400, 'bad'), { times: 1 });
  expect(await replay(google, store)).toBe('done');
  expect(await store.queue()).toEqual([]);
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
    expect(await store.queue()).toHaveLength(1);
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
