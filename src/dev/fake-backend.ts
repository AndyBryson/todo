import type { Task } from '../domain/types';
import type { Auth } from '../google/auth';
import { createFakeGoogle, type FakeGoogle, fakePosition } from '../google/fake';

function localDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

// Dev only: lets the UI be checked by hand without a Google account.
export function createFakeBackend(): { google: FakeGoogle; auth: Auth } {
  const now = new Date().toISOString();
  let position = 0;
  const task = (id: string, listId: string, title: string, extra: Partial<Task> = {}): Task => ({
    id,
    listId,
    title,
    notes: '',
    due: null,
    completed: false,
    completedAt: null,
    parent: null,
    position: fakePosition(position++),
    updated: now,
    ...extra,
  });

  const google = createFakeGoogle({
    lists: [
      { id: 'home', title: 'Home' },
      { id: 'work', title: 'Work' },
      { id: 'shopping', title: 'Shopping' },
    ],
    tasks: [
      task('h1', 'home', 'Fix the leaking tap', { due: localDate(-2) }),
      task('h2', 'home', 'Book boiler service', { due: localDate(0) }),
      task('h3', 'home', 'Sort the garage', { notes: 'Start with the shelves.' }),
      task('h4', 'home', 'Renew car insurance', { due: localDate(5) }),
      task('h5', 'home', 'Water the plants', {
        completed: true,
        completedAt: hoursAgo(5),
      }),
      task('w1', 'work', 'Write quarterly report', { due: localDate(1) }),
      task('w2', 'work', 'Plan team offsite', { due: localDate(0) }),
      task('w2a', 'work', 'Shortlist venues', { parent: 'w2' }),
      task('w2b', 'work', 'Send options to the team', { parent: 'w2' }),
      task('w3', 'work', 'Review pull requests'),
      task('w4', 'work', 'Send invoice', {
        completed: true,
        completedAt: hoursAgo(50),
      }),
      task('s1', 'shopping', 'Milk and eggs', { due: localDate(0) }),
      task('s2', 'shopping', 'Birthday present'),
    ],
  });

  const auth: Auth = {
    getToken: async () => 'fake',
    signIn: async () => undefined,
    signedIn: () => true,
    subscribe: () => () => undefined,
  };
  return { google, auth };
}
