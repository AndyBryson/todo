import { useRef, useState } from 'preact/hooks';
import type { TaskList } from '../domain/types';

interface Props {
  lists: TaskList[];
  // Carries the account label where two accounts have a list of the same name.
  listName: Record<string, string>;
  defaultListId: string | null;
  pinned: boolean;
  // Resolves true when the task was added, so a failed add keeps the typed title.
  onAdd(input: { listId: string; title: string; pinned: boolean }): Promise<boolean>;
}

export function QuickAdd({ lists, listName, defaultListId, pinned, onAdd }: Props) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const has = (id: string | null) => id !== null && lists.some((l) => l.id === id);
  const listId = has(chosen) ? chosen : has(defaultListId) ? defaultListId : (lists[0]?.id ?? null);

  async function submit(e: Event) {
    e.preventDefault();
    const text = title.trim();
    if (!text || !listId) return;
    if (await onAdd({ listId, title: text, pinned })) {
      setTitle('');
      input.current?.focus();
    }
  }

  return (
    <form class="quick-add" onSubmit={(e) => void submit(e)}>
      <select
        aria-label="List"
        value={listId ?? ''}
        onChange={(e) => setChosen(e.currentTarget.value)}
      >
        {lists.map((l) => (
          <option key={l.id} value={l.id}>
            {listName[l.id] ?? l.title}
          </option>
        ))}
      </select>
      <input
        ref={input}
        type="text"
        aria-label="New task"
        placeholder={listId ? 'Add a task' : 'No lists yet'}
        disabled={!listId}
        value={title}
        onInput={(e) => setTitle(e.currentTarget.value)}
      />
    </form>
  );
}
