import { useCallback, useEffect, useState } from 'preact/hooks';
import type { Workspace } from '../accounts/workspace';
import { buildBoard } from '../domain/board';
import type { BoardFilters } from '../domain/filters';
import type { Merged } from '../domain/merge';
import { COLUMNS, type Column as ColumnName } from '../domain/types';
import { openDetail } from './CardDetail';
import { CardMenu, copyWarning } from './CardMenu';
import { Column, type Drop } from './Column';
import type { AccountGroup } from './hooks';
import { QuickAdd } from './QuickAdd';
import { SelectionBar } from './SelectionBar';

interface Props {
  workspace: Workspace;
  merged: Merged;
  groups: AccountGroup[];
  filters: BoardFilters;
  phone: boolean;
  act(fn: () => Promise<unknown>): Promise<boolean>;
  onAdd(input: { listId: string; title: string; pinned: boolean }): Promise<boolean>;
  selecting: boolean;
  onSelecting(on: boolean): void;
}

const COLUMN_KEY = 'todo.column';

// The phone shows one column at a time, or Stack: every column on one page,
// most active first. Done goes last; it holds only the past week.
type PhoneView = ColumnName | 'Stack';
const STACK: ColumnName[] = ['Doing', 'Next', 'Backlog', 'Done'];

function loadColumn(): PhoneView {
  try {
    const saved = localStorage.getItem(COLUMN_KEY);
    if (saved === 'Stack') return 'Stack';
    return COLUMNS.find((c) => c === saved) ?? COLUMNS[0];
  } catch {
    return COLUMNS[0];
  }
}

const openTask = (id: string) => openDetail('board', id);

export function Board({
  workspace,
  merged,
  groups,
  filters,
  phone,
  act,
  onAdd,
  selecting,
  onSelecting,
}: Props) {
  const [selected, setSelected] = useState(loadColumn);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; touch: boolean } | null>(
    null,
  );
  const now = new Date();
  const board = buildBoard(merged.tasks, merged.lists, merged.entries, filters, now);

  // Cards hidden by the filter or gone after a sync drop out, so the count is what moves.
  const visibleIds = new Set(COLUMNS.flatMap((c) => board[c].map((card) => card.task.id)));
  const chosen = [...picked].filter((id) => visibleIds.has(id));
  const chosenSet = new Set(chosen);

  // Hidden or gone cards leave the selection for good, so widening the filter again
  // doesn't quietly bring them back.
  const visibleKey = [...visibleIds].sort().join(' ');
  useEffect(() => {
    const visible = new Set(visibleKey.split(' '));
    setPicked((prev) => {
      const kept = [...prev].filter((id) => visible.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [visibleKey]);

  // Select can be turned off from the sidebar too, so the picks clear here, not in the button.
  useEffect(() => {
    if (!selecting) setPicked((prev) => (prev.size > 0 ? new Set() : prev));
  }, [selecting]);

  // Select mode turns the menu off, and a menu left open would act on a card that is now a tick box.
  useEffect(() => {
    if (selecting) setMenu(null);
  }, [selecting]);

  const menuCard = menu
    ? COLUMNS.flatMap((c) => board[c]).find((c) => c.task.id === menu.id)
    : undefined;
  // A card that left the board (sync, delete, filter) must not bring the menu back if it returns.
  const menuGone = menu !== null && !menuCard;
  useEffect(() => {
    if (menuGone) setMenu(null);
  }, [menuGone]);

  const closeMenu = useCallback(() => setMenu(null), []);

  const stopSelecting = () => onSelecting(false);

  // Updates build on the latest selection, so taps in quick succession all count.
  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll(column: ColumnName) {
    const ids = board[column].map((c) => c.task.id);
    setPicked((prev) => {
      const next = new Set(prev);
      const all = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  async function moveChosen(column: ColumnName) {
    setBusy(true);
    const moved = await act(() =>
      workspace.moveCardsToBottom(chosen, column, new Date().toISOString()),
    );
    setBusy(false);
    if (moved) stopSelecting();
  }

  const listOf = new Map(
    COLUMNS.flatMap((c) => board[c].map((card) => [card.task.id, card.list.id])),
  );

  // A move into another account confirms once for the whole selection.
  async function moveChosenToList(listId: string) {
    const account = merged.listAccount[listId];
    const crossing = chosen.some((id) => merged.taskAccount[id] !== account);
    const label = groups.find((g) => g.id === account)?.label ?? 'Account';
    if (crossing && !confirm(copyWarning(label))) return;
    setBusy(true);
    const now = new Date().toISOString();
    const moved = await act(async () => {
      for (const id of chosen) {
        if (listOf.get(id) !== listId) await workspace.moveToList(id, listId, now);
      }
    });
    setBusy(false);
    if (moved) stopSelecting();
  }

  const targets = groups.map((g) => ({
    ...g,
    lists: g.lists.map((l) => ({
      id: l.id,
      name: merged.listName[l.id] ?? l.title,
      waiting: chosen.some((id) => workspace.canMoveTo(id, l.id) === 'unsent'),
    })),
  }));

  const onDrop = (d: Drop) =>
    void act(() => workspace.moveCard(d.taskId, d.column, d.insertAfter, new Date().toISOString()));

  function select(name: PhoneView) {
    setSelected(name);
    try {
      localStorage.setItem(COLUMN_KEY, name);
    } catch {
      // Storage can be blocked; the choice then lasts for this visit only.
    }
  }

  // On a phone the sheet in the bottom bar replaces the Backlog quick add.
  const stacked = phone && selected === 'Stack';
  const visible = !phone ? COLUMNS : stacked ? STACK : COLUMNS.filter((c) => c === selected);

  return (
    <>
      <div class={stacked ? 'board phone stack' : phone ? 'board phone' : 'board'}>
        {phone && (
          <div class="phone-top">
            <div class="switcher">
              <button
                type="button"
                aria-pressed={stacked}
                style={{ '--col': 'var(--topbar)' }}
                onClick={() => select('Stack')}
              >
                Stack
              </button>
              {COLUMNS.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-pressed={name === selected}
                  style={{ '--col': `var(--col-${name.toLowerCase()})` }}
                  onClick={() => select(name)}
                >
                  {name} <span class="count">{board[name].length}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {filters.priorities.size === 0 && (
          <p class="placeholder">Every priority is hidden by the filter</p>
        )}
        {filters.priorities.size > 0 &&
          visible.map((name) => (
            <Column
              key={name}
              name={name}
              cards={board[name]}
              listName={merged.listName}
              now={now}
              onOpen={openTask}
              onDrop={onDrop}
              selecting={selecting}
              selectedIds={chosenSet}
              onToggle={toggle}
              onSelectAll={selectAll}
              onMenu={(id, x, y, touch = false) => setMenu({ id, x, y, touch })}
            >
              {!phone && name === 'Backlog' && (
                <QuickAdd
                  lists={merged.lists}
                  listName={merged.listName}
                  defaultListId={workspace.lastListId()}
                  pinned={false}
                  onAdd={onAdd}
                />
              )}
            </Column>
          ))}
      </div>
      {menu && menuCard && (
        <CardMenu
          key={menu.id}
          card={menuCard}
          touch={menu.touch}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          act={act}
          workspace={workspace}
          merged={merged}
          groups={groups}
        />
      )}
      {selecting && (
        <SelectionBar
          count={chosen.length}
          busy={busy}
          targets={targets}
          onMove={(column) => void moveChosen(column)}
          onMoveToList={(listId) => void moveChosenToList(listId)}
          onCancel={stopSelecting}
        />
      )}
    </>
  );
}
