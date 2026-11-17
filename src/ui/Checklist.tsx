import { useEffect, useRef, useState } from 'preact/hooks';
import Sortable from 'sortablejs';
import { subtasksOf } from '../domain/subtasks';
import type { Task } from '../domain/types';
import type { Snapshot, Store } from '../store/db';
import { addSubtask, deleteTask, editTask, reorderSubtask, setCompleted } from '../store/edits';
import { DraftField } from './CardDetail';

interface Props {
  parent: Task;
  snapshot: Snapshot;
  store: Store;
  act(fn: () => Promise<unknown>): Promise<boolean>;
}

export function Checklist({ parent, snapshot, store, act }: Props) {
  const list = useRef<HTMLUListElement>(null);
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');
  const steps = subtasksOf(snapshot.tasks, parent.id);

  const move = (taskId: string, previousId: string | null) =>
    act(() => reorderSubtask(store, taskId, previousId, new Date().toISOString()));
  // Sortable is created once, so its handler reads the latest move through this.
  const latest = useRef(move);
  latest.current = move;

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const sortable = Sortable.create(el, {
      handle: '.step-handle',
      forceFallback: true,
      fallbackOnBody: true,
      animation: 150,
      onEnd({ item, from, to, oldIndex, newIndex }) {
        if (from === to && oldIndex === newIndex) return;
        const taskId = item.dataset.id;
        if (!taskId) return;
        const before = item.previousElementSibling;
        const previousId = before instanceof HTMLElement ? (before.dataset.id ?? null) : null;
        // Preact owns the DOM: put the row back, then let the store re-render it.
        item.remove();
        from.insertBefore(item, from.children[oldIndex ?? 0] ?? null);
        void latest.current(taskId, previousId);
      },
    });
    return () => sortable.destroy();
  }, []);

  const moveByKey = async (e: KeyboardEvent, index: number) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const step = steps[index];
    if (!step) return;
    let previous: string | null;
    if (e.key === 'ArrowUp') {
      if (index === 0) return;
      previous = steps[index - 2]?.id ?? null;
    } else {
      const next = steps[index + 1];
      if (!next) return;
      previous = next.id;
    }
    const part = (document.activeElement as HTMLElement | null)?.dataset.part;
    await move(step.id, previous);
    // Focus is on the old element until the re-render settles, so look the row up afterwards.
    requestAnimationFrame(() => {
      const row = list.current?.querySelector<HTMLElement>(`[data-id="${step.id}"]`);
      const target = row?.querySelector<HTMLElement>(`[data-part="${part ?? 'handle'}"]`);
      target?.focus();
    });
  };

  const add = async () => {
    const title = draftRef.current;
    if (!title.trim()) return;
    if (await act(() => addSubtask(store, parent.id, title, new Date().toISOString()))) {
      // Keep anything typed while the step was saving.
      if (draftRef.current === title) {
        draftRef.current = '';
        setDraft('');
      }
    }
  };

  return (
    <fieldset class="subtasks">
      <legend>Steps</legend>
      <ul class="steps" ref={list}>
        {steps.map((s, i) => (
          <li
            key={s.id}
            class={s.completed ? 'step done' : 'step'}
            data-id={s.id}
            onKeyDown={(e) => void moveByKey(e, i)}
          >
            <button
              type="button"
              class="step-handle"
              data-part="handle"
              aria-label={`Reorder “${s.title}”`}
            >
              ⠿
            </button>
            <input
              type="checkbox"
              data-part="tick"
              aria-label={`Done: ${s.title}`}
              checked={s.completed}
              onChange={(e) => {
                const completed = e.currentTarget.checked;
                void act(() => setCompleted(store, s.id, completed, new Date().toISOString()));
              }}
            />
            <DraftField
              ariaLabel={s.title}
              saved={s.title}
              onSave={(title) => {
                // A blank title is rejected, so it reverts to the saved one.
                if (title.trim()) void act(() => editTask(store, s.id, { title }));
              }}
            />
            <button
              type="button"
              class="step-delete"
              data-part="delete"
              aria-label={`Delete step “${s.title}”`}
              onClick={() => void act(() => deleteTask(store, s.id))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <input
        type="text"
        class="step-add"
        placeholder="Add a step"
        aria-label="Add a step"
        value={draft}
        onInput={(e) => {
          draftRef.current = e.currentTarget.value;
          setDraft(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void add();
          }
        }}
      />
    </fieldset>
  );
}
