import { useEffect, useState } from 'preact/hooks';
import { buildBoard } from '../domain/board';
import { COLUMNS, type Column as ColumnName } from '../domain/types';
import type { Snapshot, Store } from '../store/db';
import { addTask, moveCard, moveCardsToBottom } from '../store/edits';
import { openDetail } from './CardDetail';
import { Column, type Drop } from './Column';
import { QuickAdd } from './QuickAdd';
import { SelectionBar } from './SelectionBar';

interface Props {
  store: Store;
  snapshot: Snapshot;
  filter: ReadonlySet<string> | null;
  phone: boolean;
  act(fn: () => Promise<void>): Promise<boolean>;
}

const COLUMN_KEY = 'todo.column';

function loadColumn(): ColumnName {
  try {
    const saved = localStorage.getItem(COLUMN_KEY);
    return COLUMNS.find((c) => c === saved) ?? COLUMNS[0];
  } catch {
    return COLUMNS[0];
  }
}

const openTask = (id: string) => openDetail('board', id);

export function Board({ store, snapshot, filter, phone, act }: Props) {
  const [selected, setSelected] = useState(loadColumn);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const now = new Date();
  const board = buildBoard(snapshot.tasks, snapshot.lists, snapshot.entries, filter, now);

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

  function stopSelecting() {
    setSelecting(false);
    setPicked(new Set());
  }

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
      moveCardsToBottom(store, chosen, column, new Date().toISOString()),
    );
    setBusy(false);
    if (moved) stopSelecting();
  }

  const onDrop = (d: Drop) =>
    void act(() => moveCard(store, d.taskId, d.column, d.insertAfter, new Date().toISOString()));

  function select(name: ColumnName) {
    setSelected(name);
    try {
      localStorage.setItem(COLUMN_KEY, name);
    } catch {
      // Storage can be blocked; the choice then lasts for this visit only.
    }
  }

  // On a phone the sheet in the bottom bar replaces the Backlog quick add.
  const visible = phone ? COLUMNS.filter((c) => c === selected) : COLUMNS;

  return (
    <>
      <div class="board-toolbar">
        <button
          type="button"
          aria-pressed={selecting}
          onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
        >
          {selecting ? 'Cancel' : 'Select'}
        </button>
      </div>
      <div class={phone ? 'board phone' : 'board'}>
        {phone && (
          <div class="switcher">
            {COLUMNS.map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={name === selected}
                onClick={() => select(name)}
              >
                {name} <span class="count">{board[name].length}</span>
              </button>
            ))}
          </div>
        )}
        {visible.map((name) => (
          <Column
            key={name}
            name={name}
            cards={board[name]}
            now={now}
            onOpen={openTask}
            onDrop={onDrop}
            selecting={selecting}
            selectedIds={chosenSet}
            onToggle={toggle}
            onSelectAll={selectAll}
          >
            {!phone && name === 'Backlog' && (
              <QuickAdd
                lists={snapshot.lists}
                defaultListId={snapshot.lastListId}
                pinned={false}
                onAdd={(input) =>
                  act(async () => {
                    await addTask(store, input, new Date().toISOString());
                  })
                }
              />
            )}
          </Column>
        ))}
      </div>
      {selecting && (
        <SelectionBar
          count={chosen.length}
          busy={busy}
          onMove={(column) => void moveChosen(column)}
          onCancel={stopSelecting}
        />
      )}
    </>
  );
}
