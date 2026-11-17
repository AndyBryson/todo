import type { TaskList } from '../domain/types';
import type { GoogleApi } from '../google/api';
import type { Store } from '../store/db';

// Lists change rarely, so these go straight to Google rather than through the
// queue: queued tasks could otherwise point at a list Google hasn't made yet.

export class BlankNameError extends Error {}

function cleanName(title: string): string {
  const name = title.trim();
  if (!name) throw new BlankNameError('A list needs a name');
  return name;
}

export async function createList(
  google: GoogleApi,
  store: Store,
  title: string,
): Promise<TaskList> {
  const list = await google.insertTaskList(cleanName(title));
  await store.commit({ putLists: [list] });
  return list;
}

export async function renameList(
  google: GoogleApi,
  store: Store,
  listId: string,
  title: string,
): Promise<TaskList> {
  const list = await google.patchTaskList(listId, cleanName(title));
  await store.commit({ putLists: [list] });
  return list;
}

// Google deletes the list's tasks with it, so the mirror drops them, their
// entries and any writes still waiting for them in one go.
export async function deleteList(google: GoogleApi, store: Store, listId: string): Promise<void> {
  await google.deleteTaskList(listId);
  await store.commit((s) => {
    const gone = s.tasks.filter((t) => t.listId === listId).map((t) => t.id);
    return {
      removeLists: [listId],
      removeTasks: gone,
      removeEntries: gone.filter((id) => id in s.entries),
      dequeue: s.queued
        .filter((q) => q.op.listId === listId || (q.op.kind === 'move' && q.op.toListId === listId))
        .map((q) => q.seq),
      ...(s.lastListId === listId ? { meta: { lastListId: null } } : {}),
    };
  });
}
