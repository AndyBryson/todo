import type { Card as CardData } from '../domain/board';
import { formatDue, localDate } from '../domain/dates';
import { priorityOf } from '../domain/priority';

export const MARKERS = {
  highest: { glyph: '▲▲', label: 'Priority: Highest', tone: 'high' },
  high: { glyph: '▲', label: 'Priority: High', tone: 'high' },
  low: { glyph: '▼', label: 'Priority: Low', tone: 'low' },
  lowest: { glyph: '▼▼', label: 'Priority: Lowest', tone: 'low' },
} as const;

// Android also fires contextmenu on a long-press; the hold-and-release path in Column owns touch.
let lastPointer = 'mouse';

interface Props {
  card: CardData;
  now: Date;
  onOpen(id: string): void;
  // In selection mode a click ticks the card instead of opening it.
  selecting?: boolean;
  selected?: boolean;
  onToggle?(id: string): void;
  onMenu?(id: string, x: number, y: number): void;
}

export function Card({ card, now, onOpen, selecting, selected, onToggle, onMenu }: Props) {
  const { task, list, entry, colour } = card;
  const priority = priorityOf(entry);
  const marker = priority === 'medium' ? null : MARKERS[priority];
  const overdue = task.due !== null && !task.completed && task.due < localDate(now);

  function openMenu(e: MouseEvent | KeyboardEvent, at: { x: number; y: number }) {
    if (selecting || !onMenu) return;
    e.preventDefault();
    onMenu(task.id, at.x, at.y);
  }

  // A keyboard-opened menu has no pointer, so it hangs from the card.
  const anchor = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + 16, y: r.bottom - 8 };
  };

  return (
    <li class={selected ? 'card selected' : 'card'} data-id={task.id}>
      <button
        type="button"
        class="card-body"
        aria-pressed={selecting ? Boolean(selected) : undefined}
        onPointerDown={(e) => {
          lastPointer = e.pointerType;
        }}
        onContextMenu={(e) => {
          if (lastPointer === 'touch') {
            e.preventDefault();
            return;
          }
          const keyboard = e.clientX === 0 && e.clientY === 0;
          openMenu(e, keyboard ? anchor(e.currentTarget) : { x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            lastPointer = 'keyboard';
            openMenu(e, anchor(e.currentTarget));
          }
        }}
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
