import { listColour } from '../domain/board';
import { formatDue, localDate } from '../domain/dates';
import { DEFAULT_FILTERS } from '../domain/filters';
import { todaySections } from '../domain/today';
import type { Task } from '../domain/types';
import type { Snapshot, Store } from '../store/db';
import { addTask, setCompleted } from '../store/edits';
import { openDetail } from './CardDetail';
import { QuickAdd } from './QuickAdd';

interface Props {
  store: Store;
  snapshot: Snapshot;
  phone: boolean;
  act(fn: () => Promise<void>): Promise<boolean>;
}

export function Today({ store, snapshot, phone, act }: Props) {
  const now = new Date();
  const today = localDate(now);
  const { overdue, dueToday, pinned } = todaySections(
    snapshot.tasks,
    snapshot.entries,
    now,
    DEFAULT_FILTERS,
  );
  const listTitle = new Map(snapshot.lists.map((l) => [l.id, l.title]));

  const sections = [
    { heading: 'Planned earlier', tasks: overdue },
    { heading: 'Planned for today', tasks: dueToday },
    { heading: 'Pinned', tasks: pinned },
  ].filter((s) => s.tasks.length > 0);

  const row = (t: Task) => (
    <li class="today-row" key={t.id} style={{ '--list': listColour(t.listId) }}>
      <input
        type="checkbox"
        aria-label={`Complete “${t.title}”`}
        checked={false}
        onChange={(e) => {
          const box = e.currentTarget;
          void act(() => setCompleted(store, t.id, true, new Date().toISOString())).then((ok) => {
            if (!ok) box.checked = false;
          });
        }}
      />
      <button type="button" class="today-title" onClick={() => openDetail('today', t.id)}>
        {t.title}
      </button>
      <span class="card-meta">
        <span class="chip-static">{listTitle.get(t.listId) ?? ''}</span>
        {t.due && (
          <time class={t.due < today ? 'due overdue' : 'due'} dateTime={t.due}>
            {formatDue(t.due)}
          </time>
        )}
      </span>
    </li>
  );

  return (
    <div class="today">
      {!phone && (
        <QuickAdd
          lists={snapshot.lists}
          defaultListId={snapshot.lastListId}
          pinned={true}
          onAdd={(input) =>
            act(async () => {
              await addTask(store, input, new Date().toISOString());
            })
          }
        />
      )}
      {sections.length === 0 && <p class="placeholder">Nothing planned and nothing pinned.</p>}
      {sections.map((s) => (
        <section key={s.heading}>
          <h2>{s.heading}</h2>
          <ul class="today-list">{s.tasks.map(row)}</ul>
        </section>
      ))}
    </div>
  );
}
