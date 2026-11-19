import type { Notice } from '../store/db';
import type { SyncStatus } from '../sync/engine';

interface Props {
  status: SyncStatus;
  // Accounts whose sign-in has lapsed. Each gets its own button, as iOS only lets
  // Google's window open from a tap.
  // A label is null until the account's email is known.
  signIn: { id: string; label: string | null }[];
  queueLength: number;
  notices: (Notice & { accountId: string })[];
  actionError: string | null;
  route: string;
  onSignIn(accountId: string): void;
  onDismiss(accountId: string, id: string): void;
  // The lists-and-filters button; absent on Settings.
  menu?: { filtersOn: number; expanded: boolean; onClick(): void };
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// Also used for each account's row on the settings page.
export function statusText(status: SyncStatus): string {
  switch (status.kind) {
    case 'synced':
      return `Synced ${time(status.at)}`;
    case 'syncing':
      return 'Syncing…';
    case 'offline':
      return 'Offline';
    case 'signin':
      return 'Sign in needed';
    case 'error':
      return status.message;
    default:
      return '';
  }
}

export function Header({
  status,
  signIn,
  queueLength,
  notices,
  actionError,
  route,
  onSignIn,
  onDismiss,
  menu,
}: Props) {
  return (
    <header class="header">
      <div class="bar">
        {menu && (
          // The sidebar can be out of sight and counts only cover visible cards, so a
          // forgotten filter must show on the button that opens it.
          <button
            type="button"
            class="menu-button"
            aria-label={
              menu.filtersOn > 0
                ? `Lists and filters, ${menu.filtersOn} ${menu.filtersOn === 1 ? 'filter' : 'filters'} on`
                : 'Lists and filters'
            }
            aria-expanded={menu.expanded}
            onClick={menu.onClick}
          >
            ☰{menu.filtersOn > 0 && <span class="menu-dot" aria-hidden="true" />}
          </button>
        )}
        <nav class="nav">
          <a href="#/board" aria-current={route === 'board' ? 'page' : undefined}>
            Board
          </a>
          <a href="#/today" aria-current={route === 'today' ? 'page' : undefined}>
            Today
          </a>
        </nav>
        {/* Outside the nav, which the phone hides in favour of its bottom bar. */}
        <a
          href="#/settings"
          class="gear"
          aria-label="Settings"
          aria-current={route === 'settings' ? 'page' : undefined}
        >
          {/* The variation selector makes iOS draw text, not a colour emoji. */}
          ⚙︎
        </a>
        <div class="status">
          <div class="status-text" aria-live="polite">
            {/* Shown beside any sign-in buttons, so another account's error isn't hidden. */}
            <span class={status.kind === 'error' ? 'error' : undefined}>{statusText(status)}</span>
            {queueLength > 0 && (
              <span class="queue">
                {queueLength} {queueLength === 1 ? 'change' : 'changes'} waiting
              </span>
            )}
          </div>
          {signIn.map((a) => (
            <button key={a.id} type="button" class="primary" onClick={() => onSignIn(a.id)}>
              {a.label === null ? 'Sign in' : `Sign in to ${a.label}`}
            </button>
          ))}
        </div>
      </div>
      {actionError && (
        <p class="line error" role="alert">
          {actionError}
        </p>
      )}
      {notices.map((n) => (
        <p class="line notice" key={`${n.accountId}/${n.id}`}>
          <span>{n.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => onDismiss(n.accountId, n.id)}>
            ×
          </button>
        </p>
      ))}
    </header>
  );
}
