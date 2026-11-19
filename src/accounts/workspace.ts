import { accountLabel } from '../domain/account-name';
import { type AccountView, type Merged, mergeViews } from '../domain/merge';
import type { BoardEntries, Column, Priority, TaskList } from '../domain/types';
import type { TaskPatch } from '../google/api';
import * as edits from '../store/edits';
import * as lists from '../sync/lists';
import type { KeyValue } from './registry';
import type { Account, AccountSet } from './set';

export interface Workspace {
  merged(): Merged;
  subscribe(fn: () => void): () => void;
  lastListId(): string | null;
  addTask(input: { listId: string; title: string; pinned: boolean }, now: string): Promise<string>;
  editTask(id: string, input: Pick<TaskPatch, 'title' | 'notes' | 'due'>): Promise<void>;
  setCompleted(id: string, completed: boolean, now: string): Promise<void>;
  moveCard(id: string, column: Column, after: string | null, now: string): Promise<void>;
  moveCardToBottom(id: string, column: Column, now: string): Promise<void>;
  moveCardsToBottom(ids: readonly string[], column: Column, now: string): Promise<void>;
  setPinned(id: string, pinned: boolean, now: string): Promise<void>;
  setPriority(id: string, priority: Priority, now: string): Promise<void>;
  deleteTask(id: string): Promise<void>;
  addSubtask(parentId: string, title: string, now: string): Promise<string>;
  reorderSubtask(id: string, previousId: string | null, now: string): Promise<void>;
  canMoveTo(id: string, toListId: string): 'yes' | 'unsent' | 'step';
  moveToList(id: string, toListId: string, now: string): Promise<void>;
  createList(accountId: string, title: string): Promise<TaskList>;
  renameList(listId: string, title: string): Promise<void>;
  deleteList(listId: string): Promise<void>;
  dismissNotice(accountId: string, id: string): Promise<void>;
  accountLabel(accountId: string): string;
  renameAccount(accountId: string, name: string, now: string): Promise<void>;
  requestSync(): void;
}

const LAST_LIST_KEY = 'todo.lastList';

// Before accounts, the last-used list lived in the one store's meta, which is now the first account's.
function carryLastList(set: AccountSet, storage: KeyValue): void {
  try {
    if (storage.getItem(LAST_LIST_KEY) !== null) return;
    const first = set.all()[0];
    const listId = first?.store.snapshot().lastListId;
    if (!first || !listId) return;
    storage.setItem(LAST_LIST_KEY, JSON.stringify({ accountId: first.record.id, listId }));
  } catch {
    // Without storage the next quick add just starts from the first list.
  }
}

export function createWorkspace(set: AccountSet, storage: KeyValue): Workspace {
  let cache: { views: AccountView[]; merged: Merged } | null = null;
  carryLastList(set, storage);

  // Rebuilt only when a snapshot or the active set changed, so callers can compare by identity.
  function merged(): Merged {
    const views = set.active().map((a) => ({
      id: a.record.id,
      label: accountLabel(a.record, a.store.snapshot().accountName),
      snapshot: a.store.snapshot(),
    }));
    const same =
      cache?.views.length === views.length &&
      views.every((v, i) => {
        const was = cache?.views[i];
        return was?.id === v.id && was.label === v.label && was.snapshot === v.snapshot;
      });
    if (!cache || !same) cache = { views, merged: mergeViews(views) };
    return cache.merged;
  }

  function account(id: string | undefined, what: string): Account {
    const found = id === undefined ? undefined : set.get(id);
    if (!found || found.record.signedOut) throw new Error(`Unknown ${what}`);
    return found;
  }

  // An open screen may still hold a temporary ID that a replay has since renamed.
  function taskOwner(requestedId: string): Account {
    const m = merged();
    const direct = m.taskAccount[requestedId];
    if (direct) return account(direct, `task ${requestedId}`);
    for (const a of set.active()) {
      const id = edits.resolveId(a.store.snapshot(), requestedId);
      if (id !== requestedId && m.taskAccount[id] === a.record.id) return a;
    }
    throw new Error(`Unknown task ${requestedId}`);
  }

  const listOwner = (listId: string) => account(merged().listAccount[listId], `list ${listId}`);

  // Cards from every account share a column, so ranks are worked out over all of them.
  function othersFor(owner: Account): BoardEntries {
    const own = owner.store.snapshot().entries;
    const others: BoardEntries = {};
    for (const [id, e] of Object.entries(merged().entries)) {
      if (!Object.hasOwn(own, id)) others[id] = e;
    }
    return others;
  }

  // Each store keeps only the IDs it owns, so every other account is offered the lot.
  async function writeForeign(owner: Account, foreign: BoardEntries): Promise<void> {
    if (Object.keys(foreign).length === 0) return;
    await Promise.all(
      set
        .active()
        .filter((a) => a !== owner)
        .map((a) => edits.putEntries(a.store, foreign)),
    );
  }

  function lastListId(): string | null {
    const m = merged();
    let saved: string | null = null;
    try {
      const parsed: unknown = JSON.parse(storage.getItem(LAST_LIST_KEY) ?? 'null');
      if (parsed && typeof parsed === 'object' && 'listId' in parsed) {
        saved = typeof parsed.listId === 'string' ? parsed.listId : null;
      }
    } catch {
      // Unreadable: fall back as if nothing was saved.
    }
    // The saved list's account may since have been signed out or removed.
    if (saved !== null && Object.hasOwn(m.listAccount, saved)) return saved;
    return m.lists[0]?.id ?? null;
  }

  return {
    merged,
    subscribe: (fn) => set.subscribe(fn),
    lastListId,

    async addTask(input, now) {
      const owner = listOwner(input.listId);
      const id = await edits.addTask(owner.store, input, now, othersFor(owner));
      try {
        storage.setItem(
          LAST_LIST_KEY,
          JSON.stringify({ accountId: owner.record.id, listId: input.listId }),
        );
      } catch {
        // Without storage the next quick add just starts from the first list.
      }
      return id;
    },

    async editTask(id, input) {
      await edits.editTask(taskOwner(id).store, id, input);
    },

    async setCompleted(id, completed, now) {
      const owner = taskOwner(id);
      await edits.setCompleted(owner.store, id, completed, now, othersFor(owner));
    },

    async moveCard(id, column, after, now) {
      const owner = taskOwner(id);
      const foreign = await edits.moveCard(owner.store, id, column, after, now, othersFor(owner));
      await writeForeign(owner, foreign);
    },

    async moveCardToBottom(id, column, now) {
      const owner = taskOwner(id);
      const foreign = await edits.moveCardToBottom(owner.store, id, column, now, othersFor(owner));
      await writeForeign(owner, foreign);
    },

    // Each run of one account's cards, in board order, goes to the bottom in turn, so
    // the selection lands below the column's old bottom card in the order it showed.
    async moveCardsToBottom(ids, column, now) {
      const m = merged();
      const tasks = new Map(m.tasks.map((t) => [t.id, t]));
      const moving = [...new Set(ids)]
        .flatMap((requested) => {
          let owner: Account;
          try {
            owner = taskOwner(requested);
          } catch {
            return [];
          }
          const id = edits.resolveId(owner.store.snapshot(), requested);
          const entry = m.entries[id];
          const task = tasks.get(id);
          return entry && task && entry.column !== column ? [{ id, owner, entry, task }] : [];
        })
        .sort(edits.boardOrder);

      for (let i = 0; i < moving.length; ) {
        const owner = moving[i]?.owner as Account;
        const run: string[] = [];
        for (; i < moving.length && moving[i]?.owner === owner; i++) {
          run.push(moving[i]?.id as string);
        }
        const foreign = await edits.moveCardsToBottom(
          owner.store,
          run,
          column,
          now,
          othersFor(owner),
        );
        await writeForeign(owner, foreign);
      }
    },

    // Async so a missing owner rejects like any other failed edit rather than throwing.
    async setPinned(id, pinned, now) {
      await edits.setPinned(taskOwner(id).store, id, pinned, now);
    },
    async setPriority(id, priority, now) {
      await edits.setPriority(taskOwner(id).store, id, priority, now);
    },
    async deleteTask(id) {
      await edits.deleteTask(taskOwner(id).store, id);
    },
    async addSubtask(parentId, title, now) {
      return edits.addSubtask(taskOwner(parentId).store, parentId, title, now);
    },
    async reorderSubtask(id, previousId, now) {
      await edits.reorderSubtask(taskOwner(id).store, id, previousId, now);
    },

    canMoveTo(id, toListId) {
      const owner = taskOwner(id);
      const s = owner.store.snapshot();
      const taskId = edits.resolveId(s, id);
      if (s.tasks.find((t) => t.id === taskId)?.parent != null) return 'step';
      if (listOwner(toListId) === owner) return 'yes';
      return edits.hasUnsent(s, taskId) ? 'unsent' : 'yes';
    },

    async moveToList(id, toListId, now) {
      const owner = taskOwner(id);
      const target = listOwner(toListId);
      if (target === owner) return edits.moveToList(owner.store, id, toListId);
      await edits.copyToAccount(
        owner.store,
        target.store,
        owner.record.id,
        target.record.id,
        id,
        toListId,
        now,
      );
    },

    async createList(accountId, title) {
      const a = account(accountId, `account ${accountId}`);
      return lists.createList(a.google, a.store, title);
    },
    async renameList(listId, title) {
      const a = listOwner(listId);
      await lists.renameList(a.google, a.store, listId, title);
    },
    async deleteList(listId) {
      const a = listOwner(listId);
      await lists.deleteList(a.google, a.store, listId);
    },

    async dismissNotice(accountId, id) {
      await set.get(accountId)?.store.dismissNotice(id);
    },

    accountLabel(accountId) {
      const a = set.get(accountId);
      return a ? accountLabel(a.record, a.store.snapshot().accountName) : 'Account';
    },

    async renameAccount(accountId, name, now) {
      const a = set.get(accountId);
      if (!a) throw new Error(`Unknown account ${accountId}`);
      await edits.renameAccount(a.store, name, now);
      if (!a.record.signedOut) a.engine.requestSync();
    },

    requestSync() {
      for (const a of set.active()) a.engine.requestSync();
    },
  };
}
