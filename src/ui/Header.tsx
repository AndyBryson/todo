import type { Notice } from '../store/db';
import type { SyncStatus } from '../sync/engine';

interface Props {
  status: SyncStatus;
  queueLength: number;
  notices: Notice[];
  actionError: string | null;
  route: string;
  onSignIn(): void;
  onDismiss(id: string): void;
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function statusText(status: SyncStatus): string {
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
  queueLength,
  notices,
  actionError,
  route,
  onSignIn,
  onDismiss,
}: Props) {
  return (
    <header class="header">
      <div class="bar">
        <nav class="nav">
          <a href="#/board" aria-current={route === 'board' ? 'page' : undefined}>
            Board
          </a>
          <a href="#/today" aria-current={route === 'today' ? 'page' : undefined}>
            Today
          </a>
        </nav>
        <div class="status">
          <div class="status-text" aria-live="polite">
            <span class={status.kind === 'error' ? 'error' : undefined}>{statusText(status)}</span>
            {queueLength > 0 && (
              <span class="queue">
                {queueLength} {queueLength === 1 ? 'change' : 'changes'} waiting
              </span>
            )}
          </div>
          {status.kind === 'signin' && (
            <button type="button" class="primary" onClick={onSignIn}>
              Sign in
            </button>
          )}
        </div>
      </div>
      {actionError && (
        <p class="line error" role="alert">
          {actionError}
        </p>
      )}
      {notices.map((n) => (
        <p class="line notice" key={n.id}>
          <span>{n.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => onDismiss(n.id)}>
            ×
          </button>
        </p>
      ))}
    </header>
  );
}
