import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import Sortable from 'sortablejs';
import type { Card as CardData } from '../domain/board';
import type { Column as ColumnName } from '../domain/types';
import { Card } from './Card';

export interface Drop {
  taskId: string;
  column: ColumnName;
  insertAfter: string | null;
}

interface Props {
  name: ColumnName;
  cards: CardData[];
  now: Date;
  onOpen(id: string): void;
  onDrop(drop: Drop): void;
  children?: ComponentChildren;
  selecting?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggle?(id: string): void;
  onSelectAll?(column: ColumnName): void;
  onMenu?(id: string, x: number, y: number): void;
}

const HOLD_MS = 300;

// Sortable's touch events are touches on older browsers and pointer events on newer ones.
function touchPoint(e: Event | undefined): { x: number; y: number } | null {
  if (!e) return null;
  if (e.type.startsWith('touch')) {
    const t = (e as TouchEvent).touches[0] ?? (e as TouchEvent).changedTouches[0];
    return t ? { x: t.clientX, y: t.clientY } : null;
  }
  const p = e as PointerEvent;
  return p.pointerType === 'touch' ? { x: p.clientX, y: p.clientY } : null;
}

export function Column({
  name,
  cards,
  now,
  onOpen,
  onDrop,
  children,
  selecting = false,
  selectedIds,
  onToggle,
  onSelectAll,
  onMenu,
}: Props) {
  const list = useRef<HTMLUListElement>(null);
  const sortableRef = useRef<Sortable | null>(null);
  // Sortable is created once, so its handlers read the latest props through this.
  const latest = useRef({ name, onDrop, onMenu });
  latest.current = { name, onDrop, onMenu };

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    // A touch held past the drag delay and released without dragging opens the card menu.
    let hold: { id: string; x: number; y: number; at: number; dragged: boolean } | null = null;
    let menuOpenedAt = 0;
    const release = (item: HTMLElement) => {
      const h = hold;
      hold = null;
      if (!h || h.dragged || h.id !== item.dataset.id || Date.now() - h.at < HOLD_MS) return;
      menuOpenedAt = Date.now();
      latest.current.onMenu?.(h.id, h.x, h.y);
    };
    // The click that follows the release would otherwise open the card's detail panel.
    const swallowClick = (e: MouseEvent) => {
      if (Date.now() - menuOpenedAt < 600) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    el.addEventListener('click', swallowClick, true);
    const sortable = Sortable.create(el, {
      group: { name: 'board', put: true },
      // Done is a drop target only; position there means nothing.
      sort: name !== 'Done',
      // Native drag does not start from a button in Firefox, so use the fallback everywhere.
      forceFallback: true,
      fallbackOnBody: true,
      animation: 150,
      delay: 300,
      delayOnTouchOnly: true,
      // A held finger wobbles; without this the wobble would start a drag and no menu would open.
      fallbackTolerance: 6,
      onChoose(evt) {
        const point = touchPoint((evt as { originalEvent?: Event }).originalEvent);
        const id = evt.item.dataset.id;
        hold = point && id ? { id, ...point, at: Date.now(), dragged: false } : null;
      },
      onStart() {
        if (hold) hold.dragged = true;
      },
      onUnchoose(evt) {
        release(evt.item);
      },
      onEnd(evt) {
        const { item, from, to, oldIndex, newIndex } = evt;
        if (from === to && oldIndex === newIndex) return;
        const taskId = item.dataset.id;
        const dropped = to.dataset.column as ColumnName | undefined;
        if (!taskId || !dropped) return;
        const before = item.previousElementSibling;
        const insertAfter = before instanceof HTMLElement ? (before.dataset.id ?? null) : null;
        // Preact owns the DOM: put the card back, then let the store re-render it.
        item.remove();
        from.insertBefore(item, from.children[oldIndex ?? 0] ?? null);
        latest.current.onDrop({ taskId, column: dropped, insertAfter });
      },
    });
    sortableRef.current = sortable;
    return () => {
      el.removeEventListener('click', swallowClick, true);
      sortable.destroy();
      sortableRef.current = null;
    };
  }, []);

  // A stray drag while selecting would move one card on its own.
  useEffect(() => {
    sortableRef.current?.option('disabled', selecting);
  }, [selecting]);

  const allSelected = cards.length > 0 && cards.every((c) => selectedIds?.has(c.task.id));

  return (
    <section class="column" aria-label={name}>
      <h2>
        <span>
          {name} <span class="count">{cards.length}</span>
        </span>
        {selecting && cards.length > 0 && (
          <button type="button" class="select-all" onClick={() => onSelectAll?.(name)}>
            {allSelected ? 'Select none' : 'Select all'}
          </button>
        )}
      </h2>
      {children}
      <ul class="cards" ref={list} data-column={name}>
        {cards.map((c) => (
          <Card
            key={c.task.id}
            card={c}
            now={now}
            onOpen={onOpen}
            selecting={selecting}
            selected={selectedIds?.has(c.task.id)}
            onToggle={onToggle}
            onMenu={onMenu}
          />
        ))}
      </ul>
    </section>
  );
}
