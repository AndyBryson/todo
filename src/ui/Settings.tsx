import { useRef, useState, useSyncExternalStore } from 'preact/compat';
import type { AccountSet } from '../accounts/set';
import { statusText } from './Header';
import { useOnline } from './hooks';

export interface SettingsAccount {
  id: string;
  label: string;
  // The Google name, which an empty name falls back to.
  googleName: string | null;
  email: string | null;
  signedOut: boolean;
  needsSignIn: boolean;
  // Turned away as a second copy of an account already signed in.
  refused: boolean;
}

interface Props {
  accounts: SettingsAccount[];
  set: AccountSet;
  onRename(accountId: string, name: string): void;
  onSignIn(accountId: string): void;
  onSignOut(accountId: string): void;
  onRemove(accountId: string): void;
  onAddAccount(): void;
}

// The merged header status can stay the same while one account's changes, so each row
// reads its own engine.
function useRowStatus(set: AccountSet): Record<string, string> {
  const key = useSyncExternalStore(set.subscribe, () =>
    JSON.stringify(set.all().map((a) => [a.record.id, statusText(a.engine.status())])),
  );
  return Object.fromEntries(JSON.parse(key) as [string, string][]);
}

// Enter or leaving the field saves; Escape cancels (null).
function NameField({
  initial,
  placeholder,
  label,
  onDone,
}: {
  initial: string;
  placeholder: string;
  label: string;
  onDone(value: string | null): void;
}) {
  // Held here so a sync re-rendering the page while typing can't put the old name back.
  const [draft, setDraft] = useState(initial);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      type="text"
      class="account-name-field"
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      onInput={(e) => setDraft(e.currentTarget.value)}
      ref={(el) => {
        if (el && !done.current && document.activeElement !== el) {
          el.focus();
          el.select();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

export function Settings({
  accounts,
  set,
  onRename,
  onSignIn,
  onSignOut,
  onRemove,
  onAddAccount,
}: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const status = useRowStatus(set);
  const online = useOnline();

  function rename(account: SettingsAccount, value: string | null) {
    setRenaming(null);
    if (value === null) return;
    const name = value.trim();
    // Saving the shown name unchanged would pin it, and a later Google rename wouldn't show.
    if (name !== account.label) onRename(account.id, name);
  }

  return (
    <div class="settings">
      <h1>Settings</h1>
      <section aria-labelledby="settings-accounts">
        <h2 id="settings-accounts">Accounts</h2>
        <ul class="settings-accounts">
          {accounts.map((account) => (
            <li key={account.id} class="settings-account">
              <div class="settings-account-name">
                {renaming === account.id ? (
                  <NameField
                    initial={account.label}
                    placeholder={account.googleName ?? ''}
                    label={`Name for ${account.label}`}
                    onDone={(value) => rename(account, value)}
                  />
                ) : (
                  <span class="settings-label">{account.label}</span>
                )}
                {account.email && <span class="settings-email">{account.email}</span>}
              </div>
              <p class="settings-status">{account.signedOut ? 'Signed out' : status[account.id]}</p>
              {account.needsSignIn && account.refused && (
                <p class="account-hint">
                  Sign in with a different Google account, or remove this one.
                </p>
              )}
              <div class="account-actions">
                {renaming !== account.id && (
                  <button type="button" onClick={() => setRenaming(account.id)}>
                    Rename
                  </button>
                )}
                {account.needsSignIn && (
                  <button type="button" class="primary" onClick={() => onSignIn(account.id)}>
                    Sign in
                  </button>
                )}
                {!account.signedOut && (
                  <button type="button" onClick={() => onSignOut(account.id)}>
                    Sign out
                  </button>
                )}
                <button type="button" class="danger" onClick={() => onRemove(account.id)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
        <button
          type="button"
          class="add-account"
          disabled={!online}
          title={online ? undefined : "You're offline"}
          onClick={onAddAccount}
        >
          Add account
        </button>
      </section>
    </div>
  );
}
