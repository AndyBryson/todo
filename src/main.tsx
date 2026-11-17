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
  if (fakeMode) {
    const { createFakeBackend } = await import('./dev/fake-backend');
    const fake = createFakeBackend();
    google = fake.google;
    auth = fake.auth;
    store = await openStore('todo-fake');
  } else {
    auth = createAuth(GOOGLE_CLIENT_ID);
    google = createHttpGoogle(() => auth.getToken());
    store = await openStore();
  }
  const engine = createSyncEngine(google, store);
  engine.start();
  render(<App store={store} engine={engine} auth={auth} />, root);
}

void main();
