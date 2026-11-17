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
}: Props) {
  const list = useRef<HTMLUListElement>(null);
  const sortableRef = useRef<Sortable | null>(null);
  // Sortable is created once, so its handlers read the latest props through this.
  const latest = useRef({ name, onDrop });
  latest.current = { name, onDrop };

  useEffect(() => {
    const el = list.current;
    if (!el) return;
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
          />
        ))}
      </ul>
    </section>
  );
}
