# Setting up Todo

Steps 1 to 3 are one-off work in Google's consoles and need doing before the app can sign you in. Do them first, then tell me the client ID and I will check the app against your real account.

## 1. Google Cloud project

1. Go to <https://console.cloud.google.com/> and create a project called `todo`.
2. With `todo` selected, open **APIs & Services → Library**. Enable **Google Tasks API**, then **Google Drive API**.

## 2. OAuth consent screen

1. Open **APIs & Services → OAuth consent screen** (called **Google Auth Platform** in newer consoles).
2. User type: **External**. Give it an app name (`Todo`) and your own email for support and developer contact.
3. Add exactly these two scopes:
   - `https://www.googleapis.com/auth/tasks`
   - `https://www.googleapis.com/auth/drive.appdata`
4. Publish the app so its status is **In production**. You do not need to add yourself as a test user once it is in production. Testing mode would make Google expire your sign-in every 7 days.

Because the app is not verified by Google, the first sign-in shows a warning: "Google hasn't verified this app". It is your own app, so this is expected. Choose **Advanced → Go to Todo (unsafe)** and then allow access. You only do this once per device.

## 3. OAuth client ID

1. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Authorised JavaScript origins:
   - `https://andybryson.github.io`
   - `http://localhost:5173`
4. Leave redirect URIs empty. Create it, then copy the client ID.
5. Paste it into `GOOGLE_CLIENT_ID` in `src/config.ts`. The client ID is public by design. Never put a client secret in the repo; this app does not use one.

## 4. GitHub Pages

The repo `AndyBryson/todo` already exists.

1. Push the branch you want to publish.
2. In the repo, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Wait for the workflow to finish. The app is then at <https://andybryson.github.io/todo/>.

## 5. Install

- **Desktop Chrome:** open <https://andybryson.github.io/todo/>, then use the install icon in the address bar (or **Install Todo** from the menu).
- **iPhone Safari:** open the same address, tap **Share → Add to Home Screen**. Open it from the home screen icon from then on.

## 6. "Sign in needed"

Google's browser sign-in gives the app access for about an hour. The app tries to renew it quietly, but browsers (especially iPhone) often block that, so **Sign in needed** may appear roughly once an hour while syncing. Editing keeps working offline meanwhile and nothing is lost.

Tap **Sign in**. It opens Google's sign-in window and syncing resumes. It has to be a tap because iPhone blocks sign-in windows that open on their own.
