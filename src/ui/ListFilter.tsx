import { listColour } from '../domain/board';
import type { TaskList } from '../domain/types';

interface Props {
  lists: TaskList[];
  selected: Set<string> | null;
  onChange(next: Set<string> | null): void;
}

export function ListFilter({ lists, selected, onChange }: Props) {
  function toggle(id: string) {
    const next = new Set(selected ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Selecting every list is the same as selecting none.
    onChange(next.size === 0 || next.size === lists.length ? null : next);
  }

  return (
    <div class="filter">
      <button
        type="button"
        class="chip"
        aria-pressed={selected === null}
        onClick={() => onChange(null)}
      >
        All lists
      </button>
      {lists.map((list) => (
        <button
          key={list.id}
          type="button"
          class="chip"
          aria-pressed={selected?.has(list.id) ?? false}
          style={{ '--chip': listColour(list.id) }}
          onClick={() => toggle(list.id)}
        >
          <span class="dot" />
          {list.title}
        </button>
      ))}
    </div>
  );
}
