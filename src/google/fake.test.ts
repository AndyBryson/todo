import { describe, expect, test } from 'vitest';
import { NotFoundError } from './api';
import { createFakeGoogle } from './fake';

const setup = async () => {
  const google = createFakeGoogle({ lists: [{ id: 'L', title: 'L' }] });
  const top = await google.insertTask('L', { title: 'top' });
  const parent = await google.insertTask('L', { title: 'parent' });
  let previous: string | undefined;
  for (const title of ['a', 'b', 'c']) {
    previous = (await google.insertTask('L', { title, parent: parent.id, previous })).id;
  }
  return { google, top, parent };
};

const order = (google: Awaited<ReturnType<typeof setup>>['google'], parent: string) =>
  [...google.tasks.values()]
    .filter((t) => t.parent === parent)
    .sort((x, y) => (BigInt(x.position) < BigInt(y.position) ? -1 : 1))
    .map((t) => t.title);

describe('fake subtasks', () => {
  test('insertTask without previous goes first, with previous goes directly after it', async () => {
    const { google, parent } = await setup();
    const id = (title: string) =>
      [...google.tasks.values()].find((t) => t.title === title)?.id ?? '';
    await google.insertTask('L', { title: 'first', parent: parent.id });
    await google.insertTask('L', { title: 'after-a', parent: parent.id, previous: id('a') });
    expect(order(google, parent.id)).toEqual(['first', 'a', 'after-a', 'b', 'c']);
    await expect(
      google.insertTask('L', { title: 'x', parent: parent.id, previous: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test('a subtask is positioned among its siblings, not the top-level tasks', async () => {
    const { google, parent } = await setup();
    const first = [...google.tasks.values()].find((t) => t.title === 'a');
    expect(first?.position).toBe('00000000000000000000');
    expect(order(google, parent.id)).toEqual(['a', 'b', 'c']);
  });

  test('reorderTask puts a task after the previous sibling, or first for null', async () => {
    const { google, parent } = await setup();
    const id = (title: string) =>
      [...google.tasks.values()].find((t) => t.title === title)?.id ?? '';
    const moved = await google.reorderTask('L', id('a'), parent.id, id('b'));
    expect(order(google, parent.id)).toEqual(['b', 'a', 'c']);
    expect(moved.position).toBe(google.tasks.get(id('a'))?.position);
    await google.reorderTask('L', id('c'), parent.id, null);
    expect(order(google, parent.id)).toEqual(['c', 'b', 'a']);
  });

  test('reorderTask rejects unknown tasks, parents and previous siblings', async () => {
    const { google, top, parent } = await setup();
    const id = [...google.tasks.values()].find((t) => t.title === 'a')?.id ?? '';
    for (const call of [
      google.reorderTask('X', id, parent.id, null),
      google.reorderTask('L', 'nope', parent.id, null),
      google.reorderTask('L', id, 'nope', null),
      google.reorderTask('L', id, parent.id, 'nope'),
      google.reorderTask('L', id, parent.id, top.id),
    ]) {
      await expect(call).rejects.toBeInstanceOf(NotFoundError);
    }
  });
});
