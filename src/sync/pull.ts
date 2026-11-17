import {
  DONE_WINDOW_MS,
  mergeEntries,
  parseBoardFile,
  reconcile,
  serialiseBoard,
} from '../domain/board';
import type { BoardEntries, Task, TaskList } from '../domain/types';
import type { GoogleApi } from '../google/api';
import type { Store } from '../store/db';

const BOARD_ATTEMPTS = 3;

export type PullResult = 'written' | 'skipped';

// Fetches everything before touching the store, so a failure part-way leaves
// the mirror exactly as it was. Returns 'skipped' when an edit arrived during
// the fetch: replacing the mirror would wipe unsent local work, so the engine
// replays the queue and pulls again.
export async function pull(google: GoogleApi, store: Store, now: Date): Promise<PullResult> {
  const completedSince = new Date(now.getTime() - DONE_WINDOW_MS).toISOString();
  const lists = await google.listTaskLists();
  const tasks: Task[] = [];
  for (const list of lists) tasks.push(...(await google.listTasks(list.id, completedSince)));

  if (store.snapshot().queueLength > 0) return 'skipped';

  const computed = await syncBoard(google, store.snapshot().entries, tasks, lists, now);

  let written = false;
  await store.commit((current) => {
    if (current.queued.length > 0) return {};
    written = true;
    // Only entries for tasks that still exist; newest wins so a card moved
    // while the board synced keeps its move (the next cycle writes it to Drive).
    const live = Object.fromEntries(
      Object.entries(current.entries).filter(([id]) => id in computed),
    );
    return {
      replaceRemote: { lists, tasks },
      replaceEntries: mergeEntries(computed, live),
    };
  });
  return written ? 'written' : 'skipped';
}

// Returns the reconciled entries. If another device keeps winning the write
// race, the local result is kept and the next cycle writes it again: merging
// is newest-wins, so nothing is lost for good.
export async function syncBoard(
  google: GoogleApi,
  local: BoardEntries,
  tasks: Task[],
  lists: TaskList[],
  now: Date,
): Promise<BoardEntries> {
  const nowIso = now.toISOString();
  let result = local;
  for (let attempt = 0; attempt < BOARD_ATTEMPTS; attempt++) {
    const { raw, version } = await google.readBoard();
    const remote = parseBoardFile(raw);
    result = reconcile(tasks, lists, mergeEntries(local, remote), nowIso);
    if (serialiseBoard(result) === serialiseBoard(remote)) return result;
    if ((await google.writeBoard(serialiseBoard(result), version)) === 'ok') return result;
  }
  return result;
}
