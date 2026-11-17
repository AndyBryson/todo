import { render } from 'preact';
import { GOOGLE_CLIENT_ID } from './config';
import { createAuth } from './google/auth';
import { createHttpGoogle } from './google/http';
import { openStore } from './store/db';
import { createSyncEngine } from './sync/engine';
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

  let google: ReturnType<typeof createHttpGoogle>;
  let auth: ReturnType<typeof createAuth>;
  let store: Awaited<ReturnType<typeof openStore>>;
  let engine: ReturnType<typeof createSyncEngine> | undefined;
  const closed = () => {
    engine?.stop();
    showOpenElsewhere();
  };
  if (fakeMode) {
    const { createFakeBackend } = await import('./dev/fake-backend');
    const fake = createFakeBackend();
    google = fake.google;
    auth = fake.auth;
    store = await openStore('todo-fake', closed);
  } else {
    auth = createAuth(GOOGLE_CLIENT_ID);
    google = createHttpGoogle(() => auth.getToken());
    store = await openStore('todo', closed);
  }
  engine = createSyncEngine(google, store);
  engine.start();
  render(<App store={store} engine={engine} auth={auth} />, root);
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
