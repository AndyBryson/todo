import { AuthError, OfflineError } from './api';

export interface Auth {
  getToken(): Promise<string>;
  signIn(): Promise<void>;
  signedIn(): boolean;
  subscribe(fn: () => void): () => void;
}

const SCOPES = [
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.appdata',
].join(' ');
const GIS_URL = 'https://accounts.google.com/gsi/client';
const CONSENT_KEY = 'todo.consented';
const REFRESH_MARGIN_MS = 5 * 60_000;
// A silent request that never answers would leave every sync waiting.
const SILENT_TIMEOUT_MS = 15_000;

const hasConsented = () => {
  try {
    return localStorage.getItem(CONSENT_KEY) !== null;
  } catch {
    return false;
  }
};

const rememberConsent = () => {
  try {
    localStorage.setItem(CONSENT_KEY, '1');
  } catch {
    // Without storage the user simply signs in again next visit.
  }
};

let scriptLoad: Promise<void> | undefined;
function loadScript(): Promise<void> {
  scriptLoad ??= new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = GIS_URL;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      // Usually the device is offline; drop the tag so a later call can retry.
      el.remove();
      scriptLoad = undefined;
      reject(new OfflineError('Could not load Google sign-in'));
    };
    document.head.append(el);
  });
  return scriptLoad;
}

interface Waiting {
  resolve: () => void;
  reject: (e: Error) => void;
}

export function createAuth(clientId: string): Auth {
  let token: string | null = null;
  let expiresAt = 0;
  let client: google.accounts.oauth2.TokenClient | undefined;
  // Only the newest request is waiting on the GIS callback; each request owns its
  // own promise, so a late timeout can only ever affect itself.
  let waiting: Waiting | undefined;
  let silent: Promise<string> | undefined;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const fn of listeners) fn();
  };
  const fresh = (margin: number) => token !== null && expiresAt - Date.now() > margin;

  async function request(timeoutMs?: number): Promise<void> {
    await loadScript();
    client ??= google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (res) => {
        const current = waiting;
        waiting = undefined;
        if (res.error || !res.access_token) {
          current?.reject(new AuthError(res.error ?? 'No token returned'));
          return;
        }
        token = res.access_token;
        expiresAt = Date.now() + Number(res.expires_in ?? 3600) * 1000;
        rememberConsent();
        current?.resolve();
      },
      error_callback: (err) => {
        const current = waiting;
        waiting = undefined;
        current?.reject(new AuthError(err.type));
      },
    });
    const c = client;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const mine: Waiting = { resolve, reject };
        // A newer request supersedes an older one that never got an answer.
        waiting?.reject(new AuthError('Superseded by a newer sign-in request'));
        waiting = mine;
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            if (waiting === mine) waiting = undefined;
            reject(new AuthError('Silent sign-in timed out'));
          }, timeoutMs);
        }
        // Google shows the consent screen by itself when access is not yet granted.
        // Forcing it with 'consent' lost the popup's reply, so sign-in never finished.
        c.requestAccessToken({ prompt: '' });
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getToken() {
      if (fresh(REFRESH_MARGIN_MS) && token) return token;
      // Never prompt here: a popup outside a user gesture is blocked on iOS.
      if (!hasConsented()) throw new AuthError('Sign in needed');
      silent ??= (async () => {
        try {
          await request(SILENT_TIMEOUT_MS);
          return token as string;
        } catch (e) {
          // A failed renewal must not discard a token that still works.
          if (token !== null && fresh(0)) return token;
          throw e instanceof AuthError || e instanceof OfflineError
            ? e
            : new AuthError('Sign in needed');
        } finally {
          silent = undefined;
          notify();
        }
      })();
      return silent;
    },

    async signIn() {
      await request();
      notify();
    },

    signedIn: () => fresh(0),

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
