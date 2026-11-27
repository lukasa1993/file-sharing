# The lshare transfer API

Both deployment profiles implement the same file-transfer control API. Applications pick a profile when building or starting lshare. A browser learns the byte transport from the upload session. It never supplies an object key, signing endpoint or upload destination URL.

| Request | Response |
| --- | --- |
| `POST /api/transfers/uploads` | Send JSON containing `name`, decimal byte `size`, and optionally an `idempotencyKey`. Supply a self-hosted `target` with `mountId` and `segments`, or a recipient `requestAlias`. The result is a `201` upload session. |
| `POST /api/transfers/uploads/{id}/parts` | For a multipart session, send the one-based `partNumber`. The result gives the storage URL and PUT method for one part. |
| `POST /api/transfers/uploads/{id}/complete` | Send ordered `parts` containing `partNumber` and the storage response's `etag`. A TUS session takes an empty array. The result contains the published file's `id`, `name`, `size` and `expiresAt`. |
| `DELETE /api/transfers/uploads/{id}` | Cancel an unfinished upload. |
| `GET /api/transfers/files` | List authorized files. Cloud responses include `nextCursor` for the next page. Pass it as `cursor`. Self-hosted callers can select a folder with `mount` and `path`. |
| `GET /api/transfers/files/{id}/download` | Follow the authorized `303` redirect in the browser. The response from the storage origin or native file endpoint carries the bytes. |
| `DELETE /api/transfers/files/{id}` | Remove the owned file. The self-hosted policy moves it to trash. Cloud deletes its R2 object and reclaims the reservation after storage confirms removal. |

File and session IDs are opaque. Expiry values are Unix time in milliseconds or null. Session-bound self-hosted requests send the existing CSRF token. Cloud clients send write requests from the configured app origin.

## Share management

Both profiles expose `GET /api/shares`, `POST /api/shares` and `DELETE /api/shares/{id}` for the signed-in owner. To create a file link, send `kind: "file"` and the opaque `fileId` returned by the transfer API. To create an upload request, send `kind: "request"`. The returned `href` is the recipient URL for the active profile.

Links accept `alias`, `expiresAt` in Unix milliseconds, and an `access` choice of `public`, `password` or `verified`. Supply a password for password access. In self-hosted mode, verified access means a signed-in workspace account, and publishing a public link requires explicit `confirmPublic: true`. Self-hosted request links can select a destination `target`. The cloud profile defaults to public file links and requires verified email for every upload request. Self-hosted listings also represent existing folder and selection links.

## Cloudflare

1. The Worker verifies the sender's account. A SQLite Durable Object reserves the declared size atomically and opens a multipart upload in a dedicated private R2 bucket.
2. The browser takes each 8 MiB slice and obtains a signed `UploadPart` URL. The signature binds the key, upload ID, part number and exact content length. The browser PUTs that slice directly to R2 and reads the ETag exposed by bucket CORS. The final part may be smaller, including a zero-byte part for an empty file.
3. The Worker submits the ETag list to R2 and reads object metadata with HEAD. Publication requires the exact reserved size. Repeating completion can recover a successful R2 write whose response was lost.
4. The download route checks the owner or share grant and sends a redirect. The browser follows it directly to R2, including when requesting a range. Password forms post to the app. The app never forwards passwords, app cookies, or a file body to R2.

The Worker bundle uses the pinned `aws4fetch` signer recommended by Cloudflare. The self-hosted production image needs only its existing Remix and Effect dependencies.

The signing adapter caps a URL at 15 minutes and rounds down to the earlier file, request, or share deadline. Revocation prevents new grants immediately. A previously issued URL may still start a request until its signed deadline. A request already accepted by R2 can finish afterward.

Uploads accept at most **100,000,000 bytes per file**. A file expires 30 days after publication. The quota includes unfinished reservations, published files and objects awaiting confirmed deletion. A 3,600,000,000-byte upward crossing queues an email. Admission stops before exceeding 4,000,000,000 bytes. A scheduled job reclaims expired files and abandoned uploads. R2 outages can delay physical deletion. Stored bytes stay charged while cleanup retries. These guarantees require a private bucket written exclusively by this deployment.

## Self-hosting

The Bun adapter checks the existing session, mount, folder permissions and upload policy. It returns a same-origin TUS URL and maximum chunk size. Clients send PATCH requests to that URL. The existing self-hosted UI continues to support resumable transfers, mount browsing, folder shares, archives and administrative workflows. The shared client is available at `/assets/transfer-client.js` in both profiles.

The portable interfaces live in [shared](../shared/). The [Bun transfer adapter](../app/transfers/adapter.ts) calls the native services. The [Cloudflare transfer adapter](../cloudflare/transfers.ts) separates quota accounting from R2 operations. See the [Cloudflare deployment guide](cloudflare.md) for private settings, CORS and operator verification.
