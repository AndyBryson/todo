const dueFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

// UTC keeps the calendar date from shifting with the device's time zone.
export const formatDue = (due: string) => dueFormat.format(new Date(`${due}T00:00:00Z`));
