import type { LocalDate } from './types';

// en-CA formats as YYYY-MM-DD, which is the shape LocalDate needs.
export function localDate(now: Date, timeZone?: string): LocalDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// Google sends due dates as midnight UTC. The date part is the calendar date;
// converting through local time would shift it for anyone west of UTC.
export function fromGoogleDue(due: string | undefined): LocalDate | null {
  return due ? due.slice(0, 10) : null;
}

export function toGoogleDue(date: LocalDate): string {
  return `${date}T00:00:00.000Z`;
}

const dueFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

// UTC keeps the calendar date from shifting with the device's time zone.
export const formatDue = (due: LocalDate) => dueFormat.format(new Date(`${due}T00:00:00Z`));

export function addDays(date: LocalDate, days: number): LocalDate {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
