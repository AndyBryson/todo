import { useState } from 'preact/hooks';
import { buildBoard } from '../domain/board';
import { COLUMNS, type Column as ColumnName } from '../domain/types';
import type { Snapshot, Store } from '../store/db';
import { addTask, moveCard } from '../store/edits';
import { openDetail } from './CardDetail';
import { Column, type Drop } from './Column';
import { QuickAdd } from './QuickAdd';

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
  const now = new Date();
  const board = buildBoard(snapshot.tasks, snapshot.lists, snapshot.entries, filter, now);

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
  );
}
