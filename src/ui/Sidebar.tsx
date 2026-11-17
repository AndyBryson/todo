import { useEffect, useRef } from 'preact/hooks';
import { listColour } from '../domain/board';
import type { BoardFilters } from '../domain/filters';
import type { TaskList } from '../domain/types';
import { FilterMenu } from './FilterMenu';

interface Props {
  lists: TaskList[];
  filters: BoardFilters;
  onFilters(next: BoardFilters): void;
  selecting: boolean;
  onToggleSelect(): void;
}

export function Sidebar({ lists, filters, onFilters, selecting, onToggleSelect }: Props) {
  function toggleList(id: string) {
    const next = new Set(filters.lists ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Ticking every list is the same as ticking none.
    onFilters({ ...filters, lists: next.size === 0 || next.size === lists.length ? null : next });
  }

  return (
    <aside class="sidebar">
      <h2>Lists</h2>
      <ul class="sidebar-lists">
        {lists.map((list) => (
          <li key={list.id}>
            <label class="check" style={{ '--chip': listColour(list.id) }}>
              <input
                type="checkbox"
                checked={filters.lists?.has(list.id) ?? false}
                onChange={() => toggleList(list.id)}
              />
              <span class="dot" />
              {list.title}
            </label>
          </li>
        ))}
      </ul>
      <FilterMenu filters={filters} onFilters={onFilters} />
      <button type="button" aria-pressed={selecting} onClick={onToggleSelect}>
        {selecting ? 'Cancel' : 'Select'}
      </button>
    </aside>
  );
}

interface DrawerProps extends Props {
  open: boolean;
  onClose(): void;
}

// Always mounted so closing hands focus back to the ☰ button.
export function SidebarDrawer({ open, onClose, ...sidebar }: DrawerProps) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  // A click on the dialog itself, not its content, is a click on the backdrop.
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => e.target === el && onClose();
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [onClose]);

  return (
    <dialog
      ref={dialog}
      class="drawer"
      aria-label="Lists and filters"
      // Escape closes the dialog natively; this keeps the state in step.
      onClose={onClose}
    >
      <header class="detail-head">
        <button type="button" class="detail-close" onClick={onClose}>
          Close
        </button>
      </header>
      <div class="drawer-body">
        <Sidebar {...sidebar} />
      </div>
    </dialog>
  );
}
