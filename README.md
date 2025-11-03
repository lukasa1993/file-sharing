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
