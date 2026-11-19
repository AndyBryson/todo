import { useEffect, useState } from 'preact/hooks';
import type { TaskList } from '../domain/types';
import { QuickAdd } from './QuickAdd';

interface Props {
  route: 'board' | 'today' | 'settings';
  lists: TaskList[];
  listName: Record<string, string>;
  defaultListId: string | null;
  onAdd(input: { listId: string; title: string; pinned: boolean }): Promise<boolean>;
}

export function PhoneNav({ route, lists, listName, defaultListId, onAdd }: Props) {
  const [adding, setAdding] = useState(false);

  // Leaving a view closes the add sheet.
  useEffect(() => setAdding(false), [route]);

  useEffect(() => {
    if (!adding) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setAdding(false);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [adding]);

  return (
    <>
      {adding && (
        <div class="sheet">
          <QuickAdd
            lists={lists}
            listName={listName}
            defaultListId={defaultListId}
            pinned={route === 'today'}
            onAdd={async (input) => {
              const added = await onAdd(input);
              if (added) setAdding(false);
              return added;
            }}
          />
        </div>
      )}
      <nav class="phone-nav" aria-label="Main">
        <a href="#/board" aria-current={route === 'board' ? 'page' : undefined}>
          Board
        </a>
        <a href="#/today" aria-current={route === 'today' ? 'page' : undefined}>
          Today
        </a>
        <button type="button" aria-expanded={adding} onClick={() => setAdding(!adding)}>
          {adding ? 'Close' : 'Add'}
        </button>
      </nav>
    </>
  );
}
