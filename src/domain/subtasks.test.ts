import { expect, test } from 'vitest';
import { renumber, subtasksOf } from './subtasks';
import { task } from './test-fixtures';

test('subtasksOf orders 20-digit positions numerically and ignores other parents', () => {
  const tasks = [
    task('late', { parent: 'p', position: '00000000000000000010' }),
    task('other', { parent: 'q', position: '00000000000000000000' }),
    task('early', { parent: 'p', position: '00000000000000000009' }),
    task('top'),
  ];
  expect(subtasksOf(tasks, 'p').map((t) => t.id)).toEqual(['early', 'late']);
});

test('subtasksOf puts a task without a position last and breaks ties by id', () => {
  const tasks = [
    task('new', { parent: 'p', position: '' }),
    task('b', { parent: 'p', position: '00000000000000000001' }),
    task('a', { parent: 'p', position: '00000000000000000001' }),
  ];
  expect(subtasksOf(tasks, 'p').map((t) => t.id)).toEqual(['a', 'b', 'new']);
});

test('renumber gives zero-padded positions in the given order', () => {
  expect(renumber(['b', 'a'])).toEqual({ b: '00000000000000000000', a: '00000000000000000001' });
});
