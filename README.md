# File Sharing Remix Sample (Bun Runtime)

This sample is based on the Remix v3 demo and updated to run entirely on [Bun 1.3+](https://bun.com/docs.md). It focuses on a streamlined file-sharing flow with:

- An admin console (`/admin`) to upload and manage files.
- One-click creation of secure download and upload share links with optional expiry and limits.
- Anonymous download and upload pages that only require the generated token.

## Getting Started

1. Install [Bun](https://bun.com) `>= 1.3.0`.
2. Copy `.env.example` to `.env` and fill in the admin credentials plus storage paths.
3. Install dependencies:
   ```sh
   bun install
   ```
4. Start the development server with hot reload:
   ```sh
   bun run dev
   ```
   The app boots on `http://localhost:44100` by default.

## Production Run

```sh
bun run start
```

Set `PORT` to override the default port.

## Usage

- Visit `http://localhost:44100/admin/login` and sign in with the credentials from your `.env` file.
- Once authenticated, `http://localhost:44100/admin` lets you upload files, create download links, and request uploads.
- Download shares resolve to `GET /share/download/:token` and can serve individual files from the bundle.
- Upload shares live at `GET /share/upload/:token` and accept anonymous file submissions (stored under `tmp/uploads`).
- Share tokens respect the expiry and max-upload limits you set and can be revoked manually from the admin console.

## Configuration

Environment variables (see `.env.example`):

- `FS_ADMIN_USER` / `FS_ADMIN_PASSWORD` — credentials for the admin console.
- `FS_STORAGE_ROOT` — directory where uploaded files are stored.
- `FS_DB_DIR` — directory where share metadata is persisted (`shares.json`).
- `FS_SESSION_SECRET` — optional secret for signing session cookies (randomized at runtime when omitted).
- `FS_SESSION_MAX_AGE` — optional session lifetime in seconds (default: 8 hours).
- `PORT` — optional HTTP port (default: 44100).
- `GITHUB_WEBHOOK_SECRET` — shared secret used to validate GitHub webhook signatures (required for auto-update).

## GitHub Webhook Auto-Update

The server exposes `POST /webhooks/github`, which consumes GitHub `push` events, validates the `X-Hub-Signature-256` HMAC, and runs `git pull` inside the running project directory. Configure it as follows:

1. Set `GITHUB_WEBHOOK_SECRET` in your deployment environment.
2. In your GitHub repository settings, add a webhook pointing to `https://<your-domain>/webhooks/github`, selecting the **Push** event and reusing the same secret.
3. Optionally enable the provided workflow (`.github/workflows/auto-update.yml`), which replays the event payload back to your server with the proper `X-Hub-Signature-256` header. Define two repository secrets: `WEBHOOK_URL` (your production endpoint) and `WEBHOOK_SECRET` (the same value as `GITHUB_WEBHOOK_SECRET`).

The webhook responds with HTTP 202 once `git pull` has been queued (or reports that an update is already running). Output from the pull command is written to the server logs.
