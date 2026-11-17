import { useRef, useState } from 'preact/hooks';
import type { TaskList } from '../domain/types';

interface Props {
  lists: TaskList[];
  defaultListId: string | null;
  pinned: boolean;
  onAdd(input: { listId: string; title: string; pinned: boolean }): void;
}

export function QuickAdd({ lists, defaultListId, pinned, onAdd }: Props) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const input = useRef<HTMLInputElement>(null);

  // A list picked by hand wins; otherwise follow the last used list as it changes.
  const wanted = chosen ?? defaultListId;
  const listId = lists.some((l) => l.id === wanted) ? wanted : (lists[0]?.id ?? null);

  function submit(e: Event) {
    e.preventDefault();
    const text = title.trim();
    if (!text || !listId) return;
    onAdd({ listId, title: text, pinned });
    setTitle('');
    input.current?.focus();
  }

  return (
    <form class="quick-add" onSubmit={submit}>
      <select
        aria-label="List"
        value={listId ?? ''}
        onChange={(e) => setChosen(e.currentTarget.value)}
      >
        {lists.map((l) => (
          <option key={l.id} value={l.id}>
            {l.title}
          </option>
        ))}
      </select>
      <input
        ref={input}
        type="text"
        aria-label="New task"
        placeholder="Add a task"
        value={title}
        onInput={(e) => setTitle(e.currentTarget.value)}
      />
    </form>
  );
}
