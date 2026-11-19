import { expect, test } from 'vitest';
import { accountLabel, newerName, parseAccountFile, serialiseAccountFile } from './account-name';

test('a damaged file reads as no name', () => {
  for (const raw of [
    '{',
    '[]',
    '{"version":2,"name":"A","updatedAt":"t"}',
    '{"version":1,"name":5,"updatedAt":"2026-11-19T10:00:00.000Z"}',
    '{"version":1,"name":"A","updatedAt":"t"}',
    '{"version":1,"name":"A","updatedAt":""}',
  ]) {
    expect(parseAccountFile(raw)).toBeNull();
  }
  expect(parseAccountFile(null)).toBeNull();
});

test('round trip keeps the name', () => {
  const n = { name: 'Work', updatedAt: '2026-11-19T10:00:00.000Z' };
  const raw = serialiseAccountFile(n);
  expect(raw).toBe('{"version":1,"name":"Work","updatedAt":"2026-11-19T10:00:00.000Z"}');
  expect(parseAccountFile(raw)).toEqual(n);
});

test('newer wins and a tie goes to the remote copy', () => {
  const a = { name: 'A', updatedAt: '2026-11-19T10:00:00Z' };
  const b = { name: 'B', updatedAt: '2026-11-19T11:00:00Z' };
  expect(newerName(a, b)).toBe(b);
  expect(newerName(b, a)).toBe(b);
  const tie = { name: 'C', updatedAt: a.updatedAt };
  expect(newerName(a, tie)).toBe(tie);
  expect(newerName(null, a)).toBe(a);
  expect(newerName(a, null)).toBe(a);
  expect(newerName(null, null)).toBeNull();
});

test('label order: saved name, then Google name, then email, then Account', () => {
  const saved = { name: 'Home', updatedAt: 't' };
  const rec = { label: 'Google Name', email: 'a@example.com' };
  expect(accountLabel(rec, saved)).toBe('Home');
  expect(accountLabel(rec, { name: '', updatedAt: 't' })).toBe('Google Name');
  expect(accountLabel(rec, null)).toBe('Google Name');
  expect(accountLabel({ label: null, email: 'a@example.com' }, null)).toBe('a@example.com');
  expect(accountLabel({ label: null, email: null }, null)).toBe('Account');
});
