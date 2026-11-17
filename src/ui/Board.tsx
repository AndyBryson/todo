import { buildBoard } from '../domain/board';
import { COLUMNS } from '../domain/types';
import type { Snapshot, Store } from '../store/db';
import { addTask, moveCard } from '../store/edits';
import { Column, type Drop } from './Column';
import { QuickAdd } from './QuickAdd';

interface Props {
  store: Store;
  snapshot: Snapshot;
  filter: ReadonlySet<string> | null;
  act(fn: () => Promise<void>): Promise<void>;
}

const openTask = (id: string) => {
  location.hash = `#/board/task/${id}`;
};

export function Board({ store, snapshot, filter, act }: Props) {
  const now = new Date();
  const board = buildBoard(snapshot.tasks, snapshot.lists, snapshot.entries, filter, now);

  const onDrop = (d: Drop) =>
    void act(() => moveCard(store, d.taskId, d.column, d.insertAfter, new Date().toISOString()));

  return (
    <div class="board">
      {COLUMNS.map((name) => (
        <Column
          key={name}
          name={name}
          cards={board[name]}
          now={now}
          onOpen={openTask}
          onDrop={onDrop}
        >
          {name === 'Backlog' && (
            <QuickAdd
              lists={snapshot.lists}
              defaultListId={snapshot.lastListId}
              pinned={false}
              onAdd={(input) =>
                void act(async () => {
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
