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
}

export function Column({ name, cards, now, onOpen, onDrop, children }: Props) {
  const list = useRef<HTMLUListElement>(null);
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
    return () => sortable.destroy();
  }, []);

  return (
    <section class="column" aria-label={name}>
      <h2>
        {name} <span class="count">{cards.length}</span>
      </h2>
      {children}
      <ul class="cards" ref={list} data-column={name}>
        {cards.map((c) => (
          <Card key={c.task.id} card={c} now={now} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}
