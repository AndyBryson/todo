import { useEffect, useRef, useState } from 'preact/hooks';
import { listColour, openTaskCount } from '../domain/board';
import { type BoardFilters, toggleListFilter } from '../domain/filters';
import type { Task, TaskList } from '../domain/types';
import { FilterMenu } from './FilterMenu';
import { ListMenu } from './ListMenu';

interface Props {
  lists: TaskList[];
  tasks: Task[];
  defaultListId: string | null;
  filters: BoardFilters;
  onFilters(next: BoardFilters): void;
  selecting: boolean;
  onToggleSelect(): void;
  // Multi-select is board-only.
  showSelect: boolean;
  onCreateList(title: string): Promise<boolean>;
  onRenameList(id: string, title: string): Promise<boolean>;
  onDeleteList(id: string): Promise<boolean>;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    addEventListener('online', update);
    addEventListener('offline', update);
    return () => {
      removeEventListener('online', update);
      removeEventListener('offline', update);
    };
  }, []);
  return online;
}

// Enter or leaving the field saves; Escape cancels (null).
function NameInput({
  initial,
  label,
  onDone,
}: {
  initial: string;
  label: string;
  onDone(value: string | null): void;
}) {
  // Held here, not read from the field: a sync re-renders the sidebar while typing,
  // and a value bound to `initial` would put the old name back.
  const [draft, setDraft] = useState(initial);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      type="text"
      class="list-name"
      aria-label={label}
      value={draft}
      onInput={(e) => setDraft(e.currentTarget.value)}
      ref={(el) => {
        if (el && !done.current && document.activeElement !== el) {
          el.focus();
          el.select();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          // Inside the drawer, Escape would otherwise close the whole dialog.
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

const tasksPhrase = (n: number) => (n === 1 ? '1 task' : `${n} tasks`);

export function Sidebar({
  lists,
  tasks,
  defaultListId,
  filters,
  onFilters,
  selecting,
  onToggleSelect,
  showSelect,
  onCreateList,
  onRenameList,
  onDeleteList,
}: Props) {
  const online = useOnline();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const offline = online ? undefined : "You're offline";

  function openMenu(id: string, x: number, y: number) {
    if (online) setMenu({ id, x, y });
  }

  function rename(list: TaskList, value: string | null) {
    setRenaming(null);
    const name = value?.trim();
    if (name && name !== list.title) void onRenameList(list.id, name);
  }

  function remove(list: TaskList) {
    const n = openTaskCount(tasks, list.id);
    if (!confirm(`Delete “${list.title}” and its ${tasksPhrase(n)}? This can't be undone.`)) return;
    void onDeleteList(list.id);
  }

  function create(value: string | null) {
    setAdding(false);
    const name = value?.trim();
    if (name) void onCreateList(name);
  }

  function toggleList(id: string) {
    onFilters({
      ...filters,
      lists: toggleListFilter(
        filters.lists,
        id,
        lists.map((l) => l.id),
      ),
    });
  }

  return (
    <aside class="sidebar">
      <h2>Lists</h2>
      <ul class="sidebar-lists">
        {lists.map((list) => (
          <li
            key={list.id}
            style={{ '--chip': listColour(list.id) }}
            onContextMenu={(e) => {
              e.preventDefault();
              // The context-menu key reports no pointer position; open under the row instead.
              const r = e.currentTarget.getBoundingClientRect();
              const byKey = e.clientX === 0 && e.clientY === 0;
              openMenu(list.id, byKey ? r.left : e.clientX, byKey ? r.bottom + 4 : e.clientY);
            }}
          >
            {renaming === list.id ? (
              <NameInput
                initial={list.title}
                label={`New name for ${list.title}`}
                onDone={(value) => rename(list, value)}
              />
            ) : (
              <label class="check">
                <input
                  type="checkbox"
                  checked={filters.lists?.has(list.id) ?? true}
                  onChange={() => toggleList(list.id)}
                />
                <span class="dot" />
                {list.title}
              </label>
            )}
            {menu?.id === list.id && (
              <ListMenu
                x={menu.x}
                y={menu.y}
                canDelete={list.id !== defaultListId}
                onRename={() => setRenaming(list.id)}
                onDelete={() => remove(list)}
                onClose={() => setMenu(null)}
              />
            )}
          </li>
        ))}
        <li>
          {adding ? (
            <NameInput initial="" label="New list name" onDone={create} />
          ) : (
            <button
              type="button"
              class="new-list"
              disabled={!online}
              title={offline}
              onClick={() => setAdding(true)}
            >
              + New list
            </button>
          )}
        </li>
      </ul>
      <FilterMenu filters={filters} onFilters={onFilters} />
      {showSelect && (
        <button type="button" aria-pressed={selecting} onClick={onToggleSelect}>
          {selecting ? 'Cancel' : 'Select'}
        </button>
      )}
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
