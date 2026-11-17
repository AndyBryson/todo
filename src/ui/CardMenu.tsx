import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Card } from '../domain/board';
import { priorityOf } from '../domain/priority';
import { COLUMNS, type Column, PRIORITIES, type Priority } from '../domain/types';
import type { Store } from '../store/db';
import { deleteTask, moveCardToBottom, setPinned, setPriority } from '../store/edits';
import { openDetail } from './CardDetail';

interface Props {
  card: Card;
  x: number;
  y: number;
  onClose(): void;
  act(fn: () => Promise<unknown>): Promise<boolean>;
  store: Store;
}

type Group = 'priority' | 'move';

const EDGE = 8;
const label = (p: Priority) => p.charAt(0).toUpperCase() + p.slice(1);

export function CardMenu({ card, x, y, onClose, act, store }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Group | null>(null);
  // Set when a key opens a group, so focus lands on its first item once it has rendered.
  const focusFirstOf = useRef<Group | null>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const { task, entry } = card;
  const now = () => new Date().toISOString();

  const items = () =>
    Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);

  // Escape and Left hand focus back to the card; choosing an action must not, as Open
  // moves focus into the detail panel.
  function dismiss(restoreFocus: boolean) {
    onClose();
    if (restoreFocus && opener.current instanceof HTMLElement && opener.current.isConnected) {
      opener.current.focus();
    }
  }

  // Measured, not guessed: the menu's size depends on the expanded group and the viewport.
  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    const left = Math.max(EDGE, Math.min(x, innerWidth - el.offsetWidth - EDGE));
    const top = Math.max(EDGE, Math.min(y, innerHeight - el.offsetHeight - EDGE));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [x, y, open]);

  useEffect(() => {
    items()[0]?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const group = focusFirstOf.current;
    if (!group) return;
    focusFirstOf.current = null;
    menu.current
      ?.querySelector<HTMLButtonElement>(`[data-group="${group}"] button:not(:disabled)`)
      ?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!(e.target instanceof Node && menu.current?.contains(e.target))) onClose();
    };
    // The menu itself may scroll on a short screen; anything else moving means the card moved.
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && menu.current?.contains(e.target))) onClose();
    };
    addEventListener('pointerdown', onPointer, true);
    addEventListener('scroll', onScroll, true);
    addEventListener('resize', onClose);
    return () => {
      removeEventListener('pointerdown', onPointer, true);
      removeEventListener('scroll', onScroll, true);
      removeEventListener('resize', onClose);
    };
  }, [onClose]);

  function onKeyDown(e: KeyboardEvent) {
    const target = e.target instanceof HTMLElement ? e.target : null;
    const all = items();
    const at = target ? all.indexOf(target as HTMLButtonElement) : -1;
    const key = e.key;
    const toggles = target?.dataset.toggle as Group | undefined;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault();
      const step = key === 'ArrowDown' ? 1 : -1;
      all[(at + step + all.length) % all.length]?.focus();
    } else if (key === 'Home' || key === 'End') {
      e.preventDefault();
      all.at(key === 'Home' ? 0 : -1)?.focus();
    } else if (toggles && (key === 'ArrowRight' || key === 'Enter' || key === ' ')) {
      // Enter would otherwise click, which toggles by pointer; a key also moves focus in.
      e.preventDefault();
      focusFirstOf.current = toggles;
      setOpen(toggles);
      if (open === toggles) {
        focusFirstOf.current = null;
        menu.current
          ?.querySelector<HTMLButtonElement>(`[data-group="${toggles}"] button:not(:disabled)`)
          ?.focus();
      }
    } else if (key === 'ArrowLeft' || key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const group = target?.closest<HTMLElement>('[data-group]')?.dataset.group as
        | Group
        | undefined;
      if (group && key === 'ArrowLeft') {
        setOpen(null);
        menu.current?.querySelector<HTMLButtonElement>(`[data-toggle="${group}"]`)?.focus();
      } else {
        dismiss(true);
      }
    } else if (key === 'Tab') {
      e.preventDefault();
      dismiss(true);
    }
  }

  const run = (fn: () => Promise<unknown>) => {
    onClose();
    void act(fn);
  };

  async function remove() {
    if (!confirm(`Delete “${task.title}” from Google Tasks?`)) return;
    run(() => deleteTask(store, task.id));
  }

  const toggle = (group: Group) => setOpen(open === group ? null : group);
  const current = priorityOf(entry);

  return (
    <div
      ref={menu}
      class="card-menu"
      role="menu"
      aria-label={`Actions for ${task.title}`}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          openDetail('board', task.id);
        }}
      >
        Open
      </button>

      <button
        type="button"
        role="menuitem"
        data-toggle="priority"
        aria-haspopup="menu"
        aria-expanded={open === 'priority'}
        onClick={() => toggle('priority')}
      >
        Priority <span aria-hidden="true">{open === 'priority' ? '▾' : '▸'}</span>
      </button>
      {open === 'priority' && (
        <fieldset class="submenu" data-group="priority" aria-label="Priority">
          {PRIORITIES.map((p) => (
            <button
              key={p}
              type="button"
              role="menuitemradio"
              aria-checked={p === current}
              onClick={() => run(() => setPriority(store, task.id, p, now()))}
            >
              <span class="mark" aria-hidden="true">
                {p === current ? '✓' : ''}
              </span>
              {label(p)}
            </button>
          ))}
        </fieldset>
      )}

      <button
        type="button"
        role="menuitem"
        data-toggle="move"
        aria-haspopup="menu"
        aria-expanded={open === 'move'}
        onClick={() => toggle('move')}
      >
        Move to <span aria-hidden="true">{open === 'move' ? '▾' : '▸'}</span>
      </button>
      {open === 'move' && (
        <fieldset class="submenu" data-group="move" aria-label="Move to">
          {COLUMNS.map((c: Column) => (
            <button
              key={c}
              type="button"
              role="menuitemradio"
              aria-checked={c === entry.column}
              disabled={c === entry.column}
              onClick={() => run(() => moveCardToBottom(store, task.id, c, now()))}
            >
              <span class="mark" aria-hidden="true">
                {c === entry.column ? '✓' : ''}
              </span>
              {c}
            </button>
          ))}
        </fieldset>
      )}

      {entry.column !== 'Done' && (
        <button
          type="button"
          role="menuitem"
          onClick={() => run(() => setPinned(store, task.id, !entry.pinned, now()))}
        >
          {entry.pinned ? 'Unpin' : 'Pin to Today'}
        </button>
      )}

      <button type="button" role="menuitem" class="danger" onClick={() => void remove()}>
        Delete…
      </button>
    </div>
  );
}
