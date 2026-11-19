import type { Workspace } from '../accounts/workspace';
import { formatDue, localDate } from '../domain/dates';
import type { BoardFilters } from '../domain/filters';
import type { Merged } from '../domain/merge';
import { todaySections } from '../domain/today';
import type { Task } from '../domain/types';
import { openDetail } from './CardDetail';
import { QuickAdd } from './QuickAdd';

interface Props {
  workspace: Workspace;
  merged: Merged;
  filters: BoardFilters;
  phone: boolean;
  act(fn: () => Promise<unknown>): Promise<boolean>;
  onAdd(input: { listId: string; title: string; pinned: boolean }): Promise<boolean>;
}

export function Today({ workspace, merged, filters, phone, act, onAdd }: Props) {
  const now = new Date();
  const today = localDate(now);
  const { overdue, dueToday, pinned } = todaySections(merged.tasks, merged.entries, now, filters);

  const sections = [
    { heading: 'Planned earlier', tasks: overdue },
    { heading: 'Planned for today', tasks: dueToday },
    { heading: 'Pinned', tasks: pinned },
  ].filter((s) => s.tasks.length > 0);

  const row = (t: Task) => (
    <li class="today-row" key={t.id} style={{ '--list': merged.listColour[t.listId] }}>
      <input
        type="checkbox"
        aria-label={`Complete “${t.title}”`}
        checked={false}
        onChange={(e) => {
          const box = e.currentTarget;
          void act(() => workspace.setCompleted(t.id, true, new Date().toISOString())).then(
            (ok) => {
              if (!ok) box.checked = false;
            },
          );
        }}
      />
      <button type="button" class="today-title" onClick={() => openDetail('today', t.id)}>
        {t.title}
      </button>
      <span class="card-meta">
        <span class="chip-static">{merged.listName[t.listId] ?? ''}</span>
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
          lists={merged.lists}
          listName={merged.listName}
          defaultListId={workspace.lastListId()}
          pinned={true}
          onAdd={onAdd}
        />
      )}
      {filters.priorities.size === 0 ? (
        <p class="placeholder">Every priority is hidden by the filter</p>
      ) : (
        sections.length === 0 && <p class="placeholder">Nothing planned and nothing pinned.</p>
      )}
      {sections.map((s) => (
        <section key={s.heading}>
          <h2>{s.heading}</h2>
          <ul class="today-list">{s.tasks.map(row)}</ul>
        </section>
      ))}
    </div>
  );
}
