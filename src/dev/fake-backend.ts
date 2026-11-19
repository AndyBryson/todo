import type { Task } from '../domain/types';
import { AuthError } from '../google/api';
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

// Dev only: lets the UI be checked by hand without a Google account. Both accounts
// have a "My Tasks", so the board has a list name to tell apart.
export function createFakeBackend(which: 'me' | 'shared'): { google: FakeGoogle; auth: Auth } {
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

  const google =
    which === 'me'
      ? createFakeGoogle({
          account: { email: 'me@example.com', name: 'Me' },
          defaultListId: 'me-default',
          lists: [
            { id: 'me-default', title: 'My Tasks' },
            { id: 'home', title: 'Home' },
            { id: 'work', title: 'Work' },
          ],
          tasks: [
            task('m1', 'me-default', 'Call the dentist', { due: localDate(0) }),
            task('m2', 'me-default', 'Return library books'),
            task('h1', 'home', 'Fix the leaking tap', { due: localDate(-2) }),
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
            task('w2c', 'work', 'Book the venue', { parent: 'w2' }),
            task('w2d', 'work', 'Order lunch', {
              parent: 'w2',
              completed: true,
              completedAt: hoursAgo(2),
            }),
            task('w3', 'work', 'Review pull requests'),
            task('w4', 'work', 'Send invoice', {
              completed: true,
              completedAt: hoursAgo(50),
            }),
          ],
        })
      : createFakeGoogle({
          account: { email: 'shared@example.com', name: 'Shared' },
          defaultListId: 'shared-default',
          lists: [
            { id: 'shared-default', title: 'My Tasks' },
            { id: 'household', title: 'Household' },
            { id: 'shopping', title: 'Shopping' },
          ],
          tasks: [
            task('d1', 'shared-default', 'Book boiler service', { due: localDate(0) }),
            task('d2', 'shared-default', 'Put the bins out'),
            task('u1', 'household', 'Pay the council tax', { due: localDate(3) }),
            task('u2', 'household', 'Clear the gutters'),
            task('s1', 'shopping', 'Milk and eggs', { due: localDate(0) }),
            task('s2', 'shopping', 'Birthday present'),
          ],
        });

  // Sign-out forgets the pass, so signing back in has to bring it back.
  let signedIn = true;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const fn of [...listeners]) fn();
  };
  const auth: Auth = {
    getToken: async () => {
      if (!signedIn) throw new AuthError('Sign in needed');
      return `fake-${which}`;
    },
    signIn: async () => {
      signedIn = true;
      changed();
    },
    forget: () => {
      signedIn = false;
      changed();
    },
    signedIn: () => signedIn,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return { google, auth };
}
