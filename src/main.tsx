import { render } from 'preact';
import { type KeyValue, saveRegistry } from './accounts/registry';
import { type AccountDeps, type AccountSet, createAccountSet } from './accounts/set';
import { createWorkspace } from './accounts/workspace';
import { GOOGLE_CLIENT_ID } from './config';
import { createAuth } from './google/auth';
import { createHttpGoogle } from './google/http';
import { openStore } from './store/db';
import { App } from './ui/App';
import './ui/app.css';

const root = document.getElementById('app') as HTMLElement;
const fakeMode = import.meta.env.DEV && new URLSearchParams(location.search).has('fake');

// Each window keeps its own copy of the queue and mirror, so two at once would
// overwrite each other's edits and replay the same creates.
function showOpenElsewhere() {
  render(
    <p class="setup">Todo is open in another window. Close it, then reload this one.</p>,
    root,
  );
}

async function main() {
  if (!fakeMode && !GOOGLE_CLIENT_ID) {
    render(
      <p class="setup">
        This app is not configured yet. Follow <code>docs/setup.md</code> to add a Google client ID
        in <code>src/config.ts</code>.
      </p>,
      root,
    );
    return;
  }

  let set: AccountSet | undefined;
  const closed = () => {
    for (const a of set?.all() ?? []) a.engine.stop();
    showOpenElsewhere();
  };
  let deps: AccountDeps;
  if (fakeMode) {
    const { createFakeBackend } = await import('./dev/fake-backend');
    // Kept in memory so fake mode never touches the real accounts in localStorage.
    const data = new Map<string, string>();
    const storage: KeyValue = {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    };
    saveRegistry(storage, [
      { id: 'me', db: 'todo-fake-me', email: 'me@example.com', label: 'Me', signedOut: false },
      {
        id: 'shared',
        db: 'todo-fake-shared',
        email: 'shared@example.com',
        label: 'Shared',
        signedOut: false,
      },
    ]);
    deps = {
      storage,
      openStore: (db) => openStore(db, closed),
      connect(id) {
        const fake = createFakeBackend(id === 'shared' ? 'shared' : 'me');
        return { auth: fake.auth, google: () => fake.google };
      },
    };
  } else {
    deps = {
      storage: localStorage,
      openStore: (db) => openStore(db, closed),
      connect: (id, loginHint) => ({
        auth: createAuth(GOOGLE_CLIENT_ID, { id, loginHint }),
        google: (getToken) => createHttpGoogle(getToken),
      }),
    };
  }
  set = await createAccountSet(deps);
  const workspace = createWorkspace(set, deps.storage);
  render(<App accounts={set} workspace={workspace} />, root);
}

// Older browsers lack the Web Locks API; running unguarded beats not running.
if (!('locks' in navigator)) {
  void main();
} else {
  void navigator.locks.request(
    fakeMode ? 'todo-app-fake' : 'todo-app',
    { ifAvailable: true },
    async (lock) => {
      if (!lock) return showOpenElsewhere();
      await main();
      // Held until the window closes.
      await new Promise(() => undefined);
    },
  );
}
