import type { Card as CardData } from '../domain/board';
import { formatDue, localDate } from '../domain/dates';
import { priorityOf } from '../domain/priority';

export const MARKERS = {
  highest: { glyph: '▲▲', label: 'Priority: Highest', tone: 'high' },
  high: { glyph: '▲', label: 'Priority: High', tone: 'high' },
  low: { glyph: '▼', label: 'Priority: Low', tone: 'low' },
  lowest: { glyph: '▼▼', label: 'Priority: Lowest', tone: 'low' },
} as const;

interface Props {
  card: CardData;
  now: Date;
  onOpen(id: string): void;
  // In selection mode a click ticks the card instead of opening it.
  selecting?: boolean;
  selected?: boolean;
  onToggle?(id: string): void;
}

export function Card({ card, now, onOpen, selecting, selected, onToggle }: Props) {
  const { task, list, entry, colour } = card;
  const priority = priorityOf(entry);
  const marker = priority === 'medium' ? null : MARKERS[priority];
  const overdue = task.due !== null && !task.completed && task.due < localDate(now);
  return (
    <li class={selected ? 'card selected' : 'card'} data-id={task.id}>
      <button
        type="button"
        class="card-body"
        aria-pressed={selecting ? Boolean(selected) : undefined}
        onClick={() => (selecting ? onToggle?.(task.id) : onOpen(task.id))}
      >
        <span class="card-title">
          {selecting && (
            <span class="tick" aria-hidden="true">
              {selected ? '☑' : '☐'}
            </span>
          )}
          {task.title}
        </span>
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
          {marker && (
            <span class={`priority priority-${marker.tone}`} role="img" aria-label={marker.label}>
              {marker.glyph}
            </span>
          )}
          {card.steps && (
            <span
              class="steps-count"
              role="img"
              aria-label={`${card.steps.done} of ${card.steps.total} steps done`}
            >
              {card.steps.done}/{card.steps.total}
            </span>
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
