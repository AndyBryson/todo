import type { Card as CardData } from '../domain/board';
import { localDate } from '../domain/dates';

const dueFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

// UTC keeps the calendar date from shifting with the device's time zone.
const formatDue = (due: string) => dueFormat.format(new Date(`${due}T00:00:00Z`));

interface Props {
  card: CardData;
  now: Date;
  onOpen(id: string): void;
}

export function Card({ card, now, onOpen }: Props) {
  const { task, list, entry, colour } = card;
  const overdue = task.due !== null && !task.completed && task.due < localDate(now);
  return (
    <li class="card" data-id={task.id}>
      <button type="button" class="card-body" onClick={() => onOpen(task.id)}>
        <span class="card-title">{task.title}</span>
        <span class="card-meta">
          <span class="chip-static" style={{ '--chip': colour }}>
            <span class="dot" />
            {list.title}
          </span>
          {task.due && (
            <time class={overdue ? 'due overdue' : 'due'} dateTime={task.due}>
              {formatDue(task.due)}
            </time>
          )}
          {entry.pinned && (
            <span class="pin" role="img" aria-label="Pinned to Today">
              ★
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
