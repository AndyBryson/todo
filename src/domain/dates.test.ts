import { describe, expect, test } from 'vitest';
import { addDays, formatDue, fromGoogleDue, localDate, toGoogleDue } from './dates';

describe('calendar dates', () => {
  test('evening in Los Angeles is still the same local day though UTC has rolled over', () => {
    expect(localDate(new Date('2026-11-18T04:30:00Z'), 'America/Los_Angeles')).toBe('2026-11-17');
  });
  test('morning in Auckland is already the next day though UTC has not rolled over', () => {
    expect(localDate(new Date('2026-11-17T12:30:00Z'), 'Pacific/Auckland')).toBe('2026-11-18');
  });
  test('Google due date keeps its calendar date', () => {
    expect(fromGoogleDue('2026-11-17T00:00:00.000Z')).toBe('2026-11-17');
    expect(fromGoogleDue(undefined)).toBeNull();
    expect(toGoogleDue('2026-11-17')).toBe('2026-11-17T00:00:00.000Z');
  });
  test('addDays crosses month and year ends', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

test('a due date is shown as its own calendar day, whatever the device time zone', () => {
  expect(formatDue('2026-11-01')).toBe('1 Nov');
  expect(formatDue('2026-12-31')).toBe('31 Dec');
});
