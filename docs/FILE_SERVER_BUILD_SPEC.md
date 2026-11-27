# Self-hosted file sharing — product specification and Codex build plan

**Status:** implementation brief, architecture locked; production release subject to the gates below.  
**Documentation review:** 2026-11-27.  
**Example public origin:** `https://dl.lnh.ge`.  
**Working name:** `fileserver` (branding configurable; no product name selected).

The [Effect architecture addendum](EFFECT_SPEC.md) governs server-side composition, exceptions to the dependency policy, testing, and quality gates wherever it supersedes this document.

## 0. Instructions to Codex and architectural decisions

Build a polished private file-sharing service for friends. It should feel like a modern native file manager, preserve ordinary files and folders on disk, and serve clean, short download URLs. It is not an object-storage gateway, sync platform, or generic enterprise cloud suite.

**Hard constraints agreed with the owner**

- One integrated Remix 3 full-stack application, one repository, one package, one Bun server process, one Docker image/container, one listening HTTP port. Browser-side JavaScript is part of the same application; there is no separate SPA project, API deployment, or second server.
- TypeScript/TSX and native CSS. Remix native components, routing, controllers, data, auth, sessions, middleware, assets and validation. Do not use React, React Router, Remix v2 conventions, Next.js, Express, Vite, Tailwind, Drizzle, Better Auth or a third-party upload server.
- The approved direct production dependencies are official Remix packages and Effect core. Bun provides the runtime, SQLite, hashing, streams and native tests. The architecture addendum defines approved development tooling. Additional dependencies, native addons, executables or services require an explicit owner decision.
- Real filesystem is the source of truth. Existing folders can be mounted and browsed without importing files. Completed uploads must be ordinary named files in their intended folders, immediately accessible through the OS and other trusted applications. SQLite is for application metadata, not file bytes or a mandatory file catalog.
- Native browser downloads, resumable uploads and downloads, predictable short root-level URLs, modern accessible UI and strong security are core functionality.
- No passkeys or TOTP. Local username/password login is the initial authentication method. No public self-registration or external identity service by default.
- Prefer documented Remix APIs first, Bun/native Web APIs second, narrow app-owned extensions third. Do not fork framework internals or implement cryptography yourself. No hidden dependencies or fallback stacks.
- Linux containers are the supported production target. Test amd64 and arm64; do not assume Windows path semantics. The host administrator controls mount definitions and trusted external filesystem writers.

**Current build scope.** Deliver P0, P1, and P2 in this build. The labels order work by dependency. P0 establishes the core file manager and transfer contracts, P1 extends the workflows, and P2 covers integrations and advanced format support. Where a capability depends on an unverified API, a safety gate, or an owner decision, evaluate it during this build and record the verified behavior, supported fallback, or specific blocker.

Sections 1–10 define the product requirements. Sections 11–17 define contracts, gates, and execution. Suggested route names, defaults, and data models remain implementation proposals. Coordinate shared interfaces and document departures in an ADR. The [product brief](../PRODUCT.md) describes the users and the handoffs carried forward from the earlier app.

## 1. Filesystem and storage

**P0**

- Configure multiple named storage roots through deployment configuration. Mount existing directories directly; permit read-only roots. The admin UI manages names, enablement and permissions for allowlisted mount locations, not arbitrary host filesystem paths.
- Enumerate current directory entries from the filesystem. Files added, moved, modified or deleted externally appear on the next refresh/listing without reimport, mandatory scan or synchronization. Notify/refresh when possible; filesystem watchers are optional optimizations, not the authority.
- Preserve file names, extensions, nesting, Unicode and spaces. No hashing of final file names, blob store, content-addressed storage, or database dependence for discovering normal files.
- Create directories; rename, move, copy and delete files/directories; support multi-selection/bulk operations and explicit conflict policies. Never silently overwrite. Preserve mtime when practical; report failures and partial completion. Cross-filesystem move is copy-verify-delete, not an atomic rename; do not remove the source on partial failure.
- Support local Linux filesystems. SMB/NFS and other host-mounted filesystems are accepted as mount types but must be tested for their actual rename, durability, timestamp, locking and capacity semantics. Report unsupported operations rather than simulating guarantees. Avoid placing SQLite on SMB/NFS.
- Keep incomplete uploads, internal trash, caches and metadata separate from user-visible files. Use a protected staging directory on the destination filesystem. Reserve internal names at every access layer.
- Reject special files (devices, FIFO, sockets), symlinks and unsafe hard links by default; never follow links to discover external data. No arbitrary mount traversal. Expose only authorized, safe regular files and directories. See the security gate in §11.4.
- Use fresh metadata on each access; prevent stale cache entries from conferring access. Handle missing/unmounted roots and permission errors without falling back to the underlying empty mountpoint or exposing the host.

**P1**

- Trash with original paths, restore with conflicts, per-root retention and scheduled cleanup. Permanent deletion requires an explicit action. If trash is disabled, label deletion as permanent.
- Bulk rename, optional preservation of supported timestamps during copy, better cross-mount progress and cancellation.
- Optional bounded search index and watcher-based invalidation; never require an index to browse or download.

## 2. Downloads

**P0**

- Ordinary HTTP `GET` and `HEAD` using browser-native download behavior. No fetch-to-Blob, JS download engine, service-worker streaming workaround or buffering the file into memory.
- Support byte ranges, including open-ended and suffix ranges. Return correct 200/206/416 responses, `Content-Range`, `Accept-Ranges`, `Content-Length`, `Content-Type`, `Content-Disposition`, validators and conditional responses. Support at least single-range and multiple concurrent single-range requests. Multiple ranges in one request may be ignored with a valid full 200 response initially; do not send an incorrect 206.
- File name in `Content-Disposition` must be the actual original filename, including a safe ASCII fallback and RFC 8187 `filename*` for Unicode. A URL ending in `/rd` can download `RemoteDesktop.exe`.
- Support resume in Chrome, Firefox and ordinary download managers when the representation is unchanged and the client retains partial state. Implement `If-Range` correctly. If a validator mismatches, return a complete representation, not a suffix of the new file. Do not promise safe resumption without a valid validator or across arbitrary concurrent in-place writes.
- Serve a pinned authorized file handle or equivalent verified safe file object, not an unchecked/reopened pathname. Stream with bounded buffers, backpressure and cancellation. No file-size ceiling by default for downloads; test 100+ GiB, 64-bit offsets, zero-byte files and concurrent clients.
- Disable response compression for ranged/download representations. Avoid proxy buffering, transformations, public caching of private data and session credentials in URLs. Default to attachment; inline viewing only through safe preview policies.
- Enforce authorization on GET, HEAD, conditional requests, each range and archive request, even if the response would be 304. Release handles on completion, abort, errors and no-body responses. A response starting is not proof that the browser saved the entire file.

**P1**

- Configurable bandwidth limits, global and per-user concurrent transfer limits, transfer cancellation from administration, and measured rate reporting.
- Folder/multi-selection download as streamed TAR (or TAR.GZ) with safe entry names, no following links, bounded resources. Optionally stage completed archives for resumable downloads with expiry and cleanup. On-the-fly streams do not promise arbitrary range resumption. ZIP/ZIP64 remains desired but see §11.5; do not load giant archives into RAM.

## 3. Uploads

**P0**

- Resumable, chunked HTTP uploads with persistent server-side offsets, rather than one huge multipart request. Use Remix routes and Web Streams. Implement a documented subset of tus 1.0.0 (§12.4) or explicitly label it as app-specific until conformance is tested. No external tus server or library.
- Upload files larger than 100 GB without whole-file buffering. Drag and drop files and folders; retain relative paths. Fallback to file and folder picker; support browser feature detection. Parallel independent file uploads (initially 2–4 configurable); sequential chunks within one upload.
- Pause, resume, retry, cancel and show progress, transferred bytes, speed and ETA. Recover after page refresh/server restart. Reselect the same local file when browser security requires it; verify identity rather than assuming the browser retains file access. Pause stops further chunks; cancellation safely removes partial state if requested.
- Original destination and conflict policy are chosen at creation and revalidated on finalization. Validate declared size, quotas/reservations, free space and maximum individual chunk bytes. Enforce actual streamed bytes even without a truthful `Content-Length`.
- Stage incomplete content in a private same-filesystem area; final placement is atomic when the filesystem supports it. Default conflict action is reject; allow explicit rename/skip/overwrite. Recheck destination permission and name collision under the filesystem mutation lock. Use a tested no-replace primitive for new files where supported (e.g. hard-link a verified regular staging file into an unused name and unlink the stage on success, with appropriate filesystem tests); do not rely on check-then-overwriting rename for untrusted concurrent writers. Fail closed where no-replace cannot be assured. Explicit replacement uses atomic rename where supported. Never truncate the existing final file while uploading.
- Maintain durable upload state, safely recover crash windows, avoid committing an offset beyond durable bytes, handle duplicate/stale chunks, and clean up expired partial uploads/reservations. Completed bytes become a normal file, not a chunk directory.
- Optional streaming integrity check with SHA-256; check an expected digest when supplied. Never treat matching name/size alone as proof of identical upload content when resuming a reselected file.

**P1**

- Configurable chunk size and concurrency, per-user quotas and throttling. Quota enforcement must be conservative with external writers; display limitations and free-space changes, never claim a hard OS quota when only app-level accounting is implemented.
- Browser-local persisted queue metadata (IndexedDB), multiple selections, directory drop with relative path discovery, configurable session expiration and admin transfer controls.

## 4. Sharing and custom URLs

**P0**

- Create/edit/delete shares in the web UI, including human-readable extensionless root aliases: `https://dl.lnh.ge/rd` → `/storage/software/RemoteDesktop.exe`. No reverse proxy changes per share. Random cryptographically secure tokens are available as the default alternative.
- Direct file aliases stream content from the alias itself without a redirect. Folder aliases serve a clean browsable directory view with relative descendants confined to the selected directory. Support an optional landing page with filename/size and a prominent Download button; direct mode is default for file aliases, landing mode is an explicit share setting.
- Multiple aliases may reference one file/directory. Admin/authorized owner can rename alias, change target, disable, enable, revoke, add expiration or choose public/password/authenticated access. An alias is a reference, not a new copy of the file.
- Direct public link means anyone knowing it may download, and short aliases are guessable. Provide an explicit warning and confirmation for public sharing. Never list hidden/private shares to anonymous visitors. No unprotected public directory root by default.
- Password-protected shares hash passwords using Bun Argon2id; use a scoped session grant, not passwords in URLs, query strings or download headers. Grant is bound to share ID and revision with expiry; every subsequent request checks share state. Password changes/target changes invalidate grants. Authenticated share access does not confer unrelated directory permissions.
- Share creation requires share and appropriate read/upload permissions. Recheck owner account status, current share scope and relevant owner authorization on each request. Public recipients receive only the limited share capability. If owner loses access, disable access; administrators can explicitly transfer ownership.
- Root aliases use ASCII lowercase `[a-z0-9][a-z0-9_-]{0,63}` as proposed initial syntax, case-insensitive uniqueness enforced transactionally. Random tokens use at least 128 bits of entropy encoded within the accepted alphabet (e.g. 32 lowercase hex chars). Reserve application routes, prefixes and well-known names. Validate all encoded paths; no alias can shadow app routes. See §12.2.
- Track alias target as mount ID plus relative path, target type and optional identity/version metadata. If target disappears, mark broken, never search for a different file by name. App-mediated renames/moves can update affected share paths with an operation journal and explicit policy; external moves cannot reliably be tracked and may leave broken shares. Target replacement behavior must be explicit: default invalidate changed identity and require owner confirmation; a separately opted-in “latest at this path” share may follow a path, with new validators.
- Maintain access counters, bytes served (not client-confirmed), last access and audit events. No landing-page GET or HEAD side effects that consume quota or change authorization merely because a crawler/preview opened the page. A direct file GET may allocate a transfer lease under the explicitly enabled P1 limit policy.

**P1**

- Preserve the earlier upload-request flow. An owner selects a destination folder, optionally sets an expiry and aggregate byte cap, then copies one upload-only link. A recipient can submit files without listing, reading, overwriting, or learning the names of existing entries. Enforce the cap across concurrent and resumed uploads and recheck revocation before publishing a file.
- Preserve the earlier selection workflow. Owners can keep a selection across folders and share it in one link. Recipients can download individual items or the authorized set as an archive. Authorize each selected entry and its included descendants, including when the owner’s access changes. Keep single-file aliases direct.
- Optional download limits using defined transfer leases (§12.3), expiration, password grants, per-share bandwidth and aggregate statistics. Browser HTTP cannot perfectly identify human download actions across retries/parallel ranges; expose the lease semantics and never advertise exact completed-download counts.
- Optional alias history, expiry notification in admin UI, and batch share management. No external notification dependency.

## 5. Authentication and permissions

**P0**

- Local username/password accounts, administrators and regular users, user enable/disable, group membership, admin-managed invites/accounts, password changes and admin reset. No default credentials, open registration, passkeys or TOTP.
- First admin provisioned using a one-time local CLI/bootstrap secret read from a protected file or deployment secret; refuse startup/setup if unsafe. Do not leave a public first-visit account creation page or log credentials.
- Use official Remix credentials authentication and auth middleware. Bun Argon2id for account/share passwords; benchmark cost and bound concurrent verifications to avoid CPU/RAM DoS. Constant-ish behavior for unknown usernames (dummy hash), generic errors, max reasonable password bytes and no plaintext persistence.
- Server-side revocable SQLite sessions with signed, HTTP-only, Secure production cookies; SameSite=Lax, host-only, Path=/, explicit idle/absolute expiration. Rotate on successful authentication and privilege change; delete old sessions; logout and account/password reset revoke relevant sessions. Verify user exists/enabled and current policy at each request. Prevent concurrent writes resurrecting a revoked session.
- Groups, private home directories and shared directory grants. Granular actions: list, read/download/preview, create/upload, modify/overwrite, rename, copy, move, delete, share and manage permissions. Default deny. Evaluate source AND destination permissions, traversal and all descendants for recursive/bulk operations. File listing does not imply read, and read does not imply share.
- Policy v1 proposal: explicit grants to users/groups on mount+relative directory prefixes; nearest applicable prefix for a specific action wins, deny wins at the same specificity across principals. No implicit allowance from a sibling, prefix string match or administrator bypass of OS confinement. A deeper override grants only its subtree; ancestors are not listed unless separately permitted. Require explicit destination creation/overwrite and source move/delete as applicable. Document exact rules in contract tests; safe alternative is allow-only grants until deny inheritance is fully tested.
- API and UI must not leak disallowed paths, directory counts, metadata, thumbnails or aliases. UI disabled controls are not security enforcement. Every route, frame and media endpoint uses the same authorization service.

**P1/P2**

- P1 app-enforced per-user storage quotas, session/device list, manual session revocation and restricted API tokens (store hashed tokens, scope, expiry and revocation; no tokens in query strings). P2 optional OIDC via official Remix provider APIs; no IdP required for normal operation. Never implement new crypto protocols.

## 6. File manager interface

**P0**

- One coherent native Remix UI, fast responsive layout on desktop and mobile, system/light/dark themes, accessible keyboard interaction and good visual hierarchy. Avoid legacy FTP-like styling, oversized clutter, slow navigation and modal-heavy workflows.
- Sidebar with storage roots and relevant navigation; breadcrumbs, list/grid views, name/type/size/mtime, sorting, filename search and manual refresh. Preserve selected sort/view between visits. Provide loading, empty, error, disabled and unavailable-storage states.
- Multi-select (Ctrl/Cmd, Shift; touch alternative), context menu and visible action menu, inline rename, new folder, copy/cut/paste, move, delete and bulk operations with confirmations. Drag and drop for upload and file movement, with accessible non-drag equivalents.
- Transfer panel with active/paused/completed/failed items; navigation should not destroy an active upload queue. Upload progress per file and total; browser-native download links should bypass client navigation/frame interception. Download button is a normal link to the authorized endpoint; never fetch whole files into the UI.
- Create a share from file/folder context menu. Inline alias preview, access type, expiration, direct/landing mode, copy URL in one click, warning for guessable public links. Shares page with status and edit/revoke actions.
- Public download page must be simple: filename, size, optional preview, download button, no account needed unless share policy says otherwise. Mobile friendly; no ads, external scripts, telemetry or compulsory branding.
- Native CSS design tokens (spacing, font, surfaces, accent, borders, focus, state colors); accessible contrast, focus rings, labels, dialogs, menu navigation, reduced motion and keyboard shortcuts that do not break text entry. Use native semantic controls and official Remix UI where stable enough. No external icon package: simple app-owned SVG icons or CSS, and never render user-provided SVG as trusted UI.
- Use native Remix Component closures, `handle.update()`, `clientEntry`, frames as appropriate. No React hooks or React-compatible JSX libraries. Keep browser-only code in explicitly served client modules. Never serialize secrets, absolute server paths, ACL records or server imports into client assets.

**P1**

- Directory tree, favorites, recents, file detail panel, search over authorized subtrees, virtualized/paginated large directories, bulk rename, persistent preferences, trash UI and custom app branding/logo/favicon. Efficient rendering for thousands of entries; backend listing must also be bounded.

## 7. File previews

**P0**

- Images, browser-supported audio/video with range-based seeking, text/code shown as escaped text with a strict byte cap, unsupported-format info/download. Use server-authorized preview endpoints, not direct filesystem static paths. If a format cannot be safely rendered, download only.
- Strict allowlist plus content validation for inline media; treat file extensions and uploaded MIME metadata as untrusted. Arbitrary HTML, SVG, JS, executable and unknown types must be served as attachments; never inject their contents into the app DOM.
- Images may use Bun's native `Bun.Image` for bounded decode/re-encode and thumbnails after verifying platform support (§11.5). Set maxPixels, input-size/worker/cache quotas and output limits. No massive decode jobs on request threads. Cache derived thumbnails outside user-visible roots; keys include target identity/version and transform parameters; recheck ACL on cache hits.

**P1/P2**

- P1 fullscreen gallery, image navigation, PDF preview only in an isolated sandboxed viewer/origin if safe (otherwise attachment), audio player, text edit with optimistic version checks, source highlighting using safe text spans, Markdown preview with escaping/safe link policy, cache cleanup. Native `Bun.markdown` is a parser, not automatically a sanitizer; never inject untrusted rendered HTML without an independently tested safe rendering policy. If safe rendering cannot be proved, show source text.
- P1 archive listing for supported bounded formats, using streaming parsing where possible; reject malicious paths/links and bombs. P2 video thumbnails/transcoding, RAW, HEIC/AVIF conversion beyond verified Linux support, advanced PDF or office previews. No FFmpeg, PDF.js, office suite or other dependency added by default. These features are optional, not reasons to violate the dependency rule.

## 8. Administration

**P0**

- Integrated web admin: user/group management, storage-root configuration constrained to deployment allowlist, ACL editor, shares (including broken/expired), storage status/free space, configured limits, audit logs, failed auth tracking, current transfers, health/version and settings. All admin actions enforce server-side role checks and CSRF.
- Show mount unavailable versus empty; no secrets/absolute paths to ordinary users. Admin UI may show configured mount labels/paths if necessary.
- Structured logs with request ID, actor ID where applicable, operation, outcome and safe metadata; redact passwords, cookies, auth headers, tokens, private share URLs and sensitive path info from public logs. Bounded retention, no high-cardinality uncontrolled labels.
- Backup/restore app metadata, signing secrets and configuration. Keep independent backups of real data; SQLite backup is not a file backup. Use consistent SQLite backup (e.g. verified `VACUUM INTO` or quiesced checkpoint/close), not live copying of only a WAL database file. Restore in maintenance mode. Test restore and migrations.
- `/healthz` minimal liveness; `/readyz` minimal readiness, no stack traces/paths/secrets. Startup checks DB, migrations, configured mount identities, permissions, staging capabilities and required settings. Fail closed or mark affected roots unavailable.

**P1**

- Real-time transfer speed and aggregate bandwidth, active connection cancellation, per-user/share usage, configurable retention and preview/staging limits, diagnostic export with redaction, admin UI for session management. SSE with scoped authorization; admin can stop future chunks/streams and attempt to cancel active responses. Distinguish bytes sent by app from bytes actually persisted by recipient.

## 9. Security

**P0 — release blockers**

- Deny path traversal, path normalization ambiguity, encoded/double-encoded traversal, NUL, separator injection and internal metadata names. Compare path segments, not string prefixes. Reject symlink/magic-link paths, special files and unsafe hard links. Keep only allowed storage bind mounts; no access to host root, Docker socket or arbitrary system paths.
- Centralize filesystem confinement and authorization. Use verified open handles and lifetime management; check file type with `fstat` after opening. Never validate a path then asynchronously reopen it unchecked. Handle race conditions and hostile web users, including concurrent moves/uploads; see §11.4 for trust-boundary limitations and gate.
- Official Remix signed cookies/session/auth/CSRF/COP/CSP. Session CSRF token on all cookie-authenticated unsafe methods (including PATCH uploads, login, logout, share unlock, admin). Reject unexpected origins; no broad CORS. Bearer-token APIs may use a separately reviewed non-cookie auth policy. Do not put tokens in URLs. Validate inputs with `remix/data-schema` and domain checks.
- Default restrictive CSP with nonce integration for app rendering, `frame-ancestors 'none'`, `object-src 'none'`, appropriate `base-uri`, `X-Content-Type-Options: nosniff`, Referrer-Policy, anti-clickjacking and HSTS only on configured HTTPS deployments. No `unsafe-eval` or broadly unsafe script policy to make hydration work. Test actual browser CSP/asset behavior; CSP does not make arbitrary same-origin HTML safe.
- TLS directly or via existing trusted reverse proxy. Explicit canonical `PUBLIC_ORIGIN`; validate allowed hosts and forwarded protocol/IP only from configured trusted proxy addresses. Never trust arbitrary Host, X-Forwarded-For or X-Forwarded-Proto. Secure production cookies even behind TLS termination. Do not publish protected response caches.
- Rate limit login/share password attempts by account and trusted client identity plus global budget; bound concurrent Argon2 checks and request/body/filename/alias lengths. Avoid permanent account-lockout DoS. Audit blocked attempts. Rate-limit expensive search, archives, thumbnail jobs and transfers. Use app-native memory/SQLite, not Redis.
- Prevent SQL injection (parameterized Data Table queries); XSS (escaped UI, strict preview policy); upload collision and overwrite races; quota races; archive traversal; open redirects; CSRF; account/session fixation; revoked-share reuse; user enumeration and secret leakage.
- Secure tokens via `crypto.getRandomValues`/Web Crypto, no homemade crypto. Use signed opaque session IDs. Restrict permissions at each request and recheck long-running operations before final write; cancellation/abort of already-streaming bytes is best effort. An account revocation cannot unsend bytes already delivered.
- Run as non-root, no privileged container, no Docker socket, cap-drop ALL, no-new-privileges, read-only application root where possible, writable data/staging volumes only; minimize mounts. Do not log secret values. Patch pinned Bun/Remix regularly; audit lockfile transitive advisories and license inventory.
- No unsafe feature or endpoint ships merely because a frontend hides it. Development mocks and insecure shortcuts must not be present in the production route graph. Security tests are mandatory before publishing to the Internet.

## 10. Performance and reliability

**P0**

- Bounded-memory file transfer; explicit stream backpressure, resource cleanup, cancellations, 64-bit-safe sizes and offsets. Never use `arrayBuffer`, `.bytes`, `.text` or materialized `File` for unrestricted large uploads/downloads. Small bounded metadata/preview/control payloads are exceptions.
- Fast idle startup, low CPU/RAM, no compulsory full-volume indexing. Direct directory metadata, bounded listing/sorting/search; use lazy previews. Optimize disk/network I/O instead of assuming zero-copy from framework docs. Benchmark on actual Bun + Linux + proxy deployment.
- SQLite local durable metadata, WAL, foreign keys enabled, appropriate busy timeout, short transactions, durable upload offsets. Avoid per-byte database writes and holding DB transactions over awaits/network IO. Single process owns migrations and DB lifecycle. WAL still has one writer; manage contention.
- Concurrent users and transfers with bounded queues, cancellation and per-user fairness. Limit background image/archive/search work separately. Test slow clients and disconnections, including stalled reads/writes and SSE. Configure body size and idle timeout deliberately at Bun and reverse proxy layers.
- Graceful shutdown: stop accepting new mutating jobs, drain or safely checkpoint uploads, abort after bounded grace, close handles/DB and recover on restart. Crash-safe staged file publication; never claim atomicity across DB and filesystem without reconciliation.
- Test empty/missing/read-only/full disks, external changes, permissions, partial I/O, restarts, mount loss and data corruption. Support multi-terabyte roots with no dependency on total file count for startup or ordinary navigation.

**P1**

- Instrument throughput, peak RSS, open descriptors, event loop responsiveness and job queues; optional streaming digest cache, efficient bulk operations, bandwidth shaping and load benchmarks. Target gigabit/multi-gigabit networks on capable hardware; do not guarantee throughput without measurement.

---

## 11. Verified stack, caveats and preflight gates

### 11.1 Version and dependency policy

- The implementation pins `remix@3.3.0`, `effect@4.1.7`, and Bun `1.4.5`. The repository includes `bun.lock` and the Linux base image digest. Check release and security notices, registry integrity, engine requirements, and resolved exports when updating a pin.
- `@remix-run/ui` is official but currently explicitly unstable and versioned separately. Use only documented primitives, optionally wrap them locally for controlled upgrades. Use native semantic HTML when a primitive is absent; no imported React UI kits. Do not invent an exact UI version without registry verification.
- Verify the official starter with Bun and retain official Remix agent skill (`.agents/skills/remix`, when included/available). Use `remix/component` JSX runtime, not React. Bun has native `bun check`, `bun fmt`, `bun lint`, `bun test` in the documented runtime generation; confirm command flags on pinned runtime. Pick `bun:test` as default; Remix Test is available but not mandatory. No redundant test/build runner. Use local Chrome/Firefox manual checks or Bun.WebView where supported; it is experimental and needs a browser installed on Linux, not a production dependency.
- Dependency allowlist check: package.json direct deps only approved official packages; review dev deps too. Transitive dependencies of Remix are allowed and locked, not hand-waved away. No CDN scripts/fonts or runtime network dependency for normal UI. Run `bun install --frozen-lockfile`, dependency audit, and review all security findings.

### 11.2 API mapping

The table records the intended API choices. The [implementation evidence](implementation-status.md) records what has run on the pinned stack.

| Need | Preferred documented API | What we own / must test |
|---|---|---|
| Full stack and routing | `remix/router`, `remix/routes`, `createRouter`, `router.fetch` | Route ordering, HEAD behavior, catch-all aliases, typed context |
| HTTP runtime | Bun `node:http` with `remix/node-fetch-server` | Origin normalization, peer address, abort, timeouts, body limits and content length on the wire |
| UI | `remix/component`, `remix/component/server`, `remix/middleware/render` | SSR, hydration, native download bypass, UI state; closure pattern |
| UI primitives | `@remix-run/ui/*` | Pin unstable official release; test behavior/accessibility |
| Assets | `remix/assets`, `remix/middleware/static` | Production asset mapping and cache; static only for app-owned files |
| SQLite | `bun:sqlite`, `remix/data-table/sqlite`, `createSqliteDatabase` | Existing native client or adapter config, schema/migrations, WAL/backup |
| Validation | `remix/data-schema` | Domain-specific paths, permissions and protocol constraints |
| Auth | `remix/auth`: `createCredentialsAuthProvider`, `verifyCredentials`, `completeAuth` | Account records, local verification, safe redirects, lifecycle |
| Auth middleware | `remix/middleware/auth`: `auth`, `createSessionAuthScheme`, `requireAuth` | User lookup on each request, route guards, custom scoped share principal |
| Sessions | `remix/cookie`, `remix/session`, `remix/middleware/session` | Signed opaque IDs, app-owned SQLite SessionStorage adapter; compile against actual interface and test read/save/rotate/destroy/expiry |
| CSRF/COP/CSP | `remix/middleware/csrf`, `/cop`, `/csp` | Order and explicit policies; CSP integration, raw upload bodies not parsed prematurely |
| Local file IO | `remix/fs`, `remix/lazy-file`, `node:fs/promises`, `Bun.file` | Safe descriptor handling; ordinary directory operations; path safety |
| Downloads | `remix/response/file`: `createFileResponse`; `remix/headers`: `ContentDisposition`; `remix/mime` | Explicit ranges, streaming digest, disposition, cache policy, validators, pinned handle and cancellation |
| Bounded forms | `remix/middleware/form-data`, `remix/form-data-parser` | Login/control forms only; strict limits; not whole-file resumable upload protocol |
| Resumable upload | Remix controllers + Fetch `Request.body`, Web Streams, native filesystem | App-owned offset protocol, staging, retry, durable finalization |
| Passwords/tokens | `Bun.password.hash/verify`, `crypto.getRandomValues`, `node:crypto` streaming hashes | Cost tuning, rate limiting, opaque IDs, secure secret storage |
| Security / authorization | Remix middleware + custom typed context/service | Central ACL, filesystem confinement, rate limiter, security headers |
| Image previews | `Bun.Image` | Platform formats, limits, safe decode/re-encode, cache |
| TAR / Markdown | `remix/tar-parser`, `Bun.Archive`, `Bun.markdown` where appropriate | Safe bounded parsing; streaming export and sanitized display are not automatic |
| Transfer events | Web `ReadableStream` SSE | Scoped subscriptions, cancellation, heartbeat, bounded queues |
| Tests/tooling | `bun:test`, `bun check`, `bun fmt`, official Remix docs/skill | Actual HTTP + browser + adversarial FS tests |

**Do not use `remix/file-storage/fs` for the user file tree.** Its built-in key/value adapter hashes storage names. `remix/fs` is the native filesystem-oriented layer; use standard fs APIs for directory operations. If an official file helper cannot safely accept an authorized handle or preserve lifetime/streaming, use a narrow Bun/Web API adapter inside the Remix handler rather than exposing unsafe paths.

### 11.3 Critical download details

The current `FileResponseOptions` lists `acceptRanges`, `etag`, `digest`, `lastModified` and `cacheControl`. Explicitly set `acceptRanges: true` for downloads, including compressible MIME types. Default weak ETags are not strong `If-Range` validators. Default strong digest via Web Crypto can buffer the entire file. Use an app-owned streaming `digest(file)` with `etag: 'strong'` when serving a stable representation; cache validated digests only under a defensible file identity/version contract. Never overwrite the ETag header after the helper has already evaluated preconditions. See source R3 below.

- Choose stable-file policy: app writes replace atomically; pinned open handles survive a rename/unlink and continue serving that version. External writers must be trusted and avoid in-place modification of files being served, or coordinate access/publish by atomic rename. For mutable sources, detect changes and invalidate caches, use conservative validators and refuse/restart unsafe resume; immutable snapshots are an optional explicit future mode, not hidden blob storage. No pure metadata check can prove a file wasn't concurrently rewritten.
- Streaming digest reads bytes in bounded chunks; hashing a 100 GiB external file can be expensive. Compute on first stable access or during finalization, memoize with mount/file identity, size, high-resolution mtime/ctime as supported, invalidation and bounded cache. For trusted stable files, revalidate before/after hashing; do not claim metadata cache is cryptographic proof against hostile local writers. A digest cached for one file version cannot be reused for a changed file. For unversioned mutable files use conservative fallback and clearly limit resume guarantees.
- Test official helper against RFC 9110 and actual Bun wire behavior (Bun also has native range/If-Range processing in recent versions). Avoid double application of Range/HEAD. If the helper fails a required case, adapt narrowly within Remix and write regression tests. Test Unicode disposition, compression exclusion and closing handles after GET/HEAD/304/416/abort.
- Native `Bun.file` may benefit from sendfile; wrappers, TLS, digest computation and metering can change that path. Measure; do not claim zero-copy for the actual Remix route unless observed.

### 11.4 Filesystem confinement — mandatory security spike

This is the main architectural risk. Remix does not provide OS-level root confinement. Bun documents experimental `bun:ffi` as unsuitable for production reliance. Ordinary path normalization, `realpath`/`lstat` checks and final-component `O_NOFOLLOW` alone are not sufficient against hostile concurrent parent replacement. Linux `openat2` can enforce resolution rules relative to a directory FD, but there is no verified first-class Remix/Bun API covering secure relative opens **and all mutations**. Do not hide this by promising universal race safety.

**Default trust model proposed for this private server:** the host admin, mount providers and external SSH/SMB/NFS writers are trusted to publish ordinary files, not perform adversarial directory reparenting, link insertion or mount manipulation. Web users, anonymous recipients and uploaded content are untrusted. Web operations never create symlinks/hardlinks (apart from tightly controlled internal publication), devices or special files. The container only sees intentionally exposed non-overlapping roots plus protected app data. No other hostile process shares writable roots. External edits are supported under this contract. Explicitly document this limitation in deployment docs and admin settings.

- Gate G2 must demonstrate a root-scoped resolver and safe handle-based IO under the pinned Linux/Bun stack. Consider descriptor-relative traversal with per-component no-follow directory opens and a tested Linux `/proc/self/fd` approach if viable; **do not assume that this is a substitute for openat2 or solves directory reparenting**. Use a single root-scoped mutation lock/policy to exclude app-controlled path races; handle two roots in deterministic order. Never trust an unvalidated absolute path, use no-follow flags where verified, verify handles/parents before use, and refuse links/special files. Do not expose private data inside any root or rely on `realpath` alone. Restrict ownership/modes; reject unsafe nested mounts and hard links or explicitly approve them with a threat-model review. For app-supplied hardlink publication, the temporary link must be private and removed; only normal single-link files become visible.
- Test symlink attacks, concurrent path swaps, rename across ACL boundaries, hardlink aliasing, malicious paths, special files and root disappearance. For trusted external writers, use a fail-closed best-effort detection policy and document remaining non-adversarial concurrent change behavior. If the proof fails even for the supported threat model, do not ship public writes/downloads.
- If hostile external local writers must be supported, stop and request an architecture decision. A reviewed first-party Linux native binding/helper using `openat2`, dirfd-relative mutations and OS isolation could be justified (still no third-party npm package, but an exception to pure TS/Bun and potentially single-process constraints). Do not silently add it, use experimental FFI in production, or claim `openat2` alone solves rename/ACL/hardlink threats. Alternatively restrict external writers with OS mount/permissions. Internet-facing release requires the owner to accept the actual supported threat model and passing tests.

### 11.5 Dependency-free media/archive limits

- Bun v1.4 provides native image operations. Official docs list JPEG/PNG/WebP and BMP/GIF decode on Linux; HEIC/AVIF may not be available there. Use `Bun.Image` with explicit `maxPixels` and input/output bounds; no format claims until tested in the actual image. Derivative caches can be rebuilt. Browser-native previews are format/codec dependent.
- Provide bounded streaming TAR export with optional streaming gzip. Use the official `remix/tar-parser` for supported inspection. Evaluate ZIP/ZIP64 on the pinned stack during this build. Enabling ZIP requires a verified native writer or owner approval for an implementation or dependency. Record the result and identify the actual archive format in the download action. Do not invoke shell `tar`, `zip`, FFmpeg or install utilities silently. No archive extraction endpoint in P0.
- `Bun.markdown` does not automatically establish XSS safety. Render safe escaped text or a narrowly allowlisted AST/renderer only after tests; no raw HTML or arbitrary dangerous link URLs.

## 12. Shared implementation contracts

### 12.1 Data and filesystem contracts — freeze before parallel code

Proposed interfaces (app-owned TypeScript contracts, not claims about framework signatures). Coordinator may refine before freezing; use exact package exports/types for integrations.

```ts
// app/contracts/domain.ts — no server implementation imports
export type ResourceRef = { mountId: string; segments: readonly string[] };
export type Action = 'list' | 'read' | 'create' | 'upload' | 'modify' |
  'rename' | 'copy' | 'move' | 'delete' | 'share' | 'manage';
export type Principal =
  | { kind: 'user'; userId: string; sessionId: string }
  | { kind: 'share'; shareId: string; revision: number; grantId?: string }
  | { kind: 'anonymous' };
export type EntryDto = {
  ref: ResourceRef; name: string; kind: 'file' | 'directory';
  size: number | null; modifiedAt: string | null; version: string;
  permissions: readonly Action[];
};
export type UploadState = 'created' | 'receiving' | 'finalizing' |
  'completed' | 'cancelled' | 'expired' | 'failed';
export type ConflictPolicy = 'reject' | 'rename' | 'overwrite' | 'skip';
```

- Resource IDs are logical mount ID + validated segments, never absolute path from client. Parse exactly once at the boundary. Do not normalize dangerous input into an acceptable path. Reject `.`/`..`, empty/embedded separators, NUL and reserved internal names; enforce name length in bytes according to mount. Preserve valid Unicode bytes (do not silently NFC-normalize/rename existing filesystem entries). Safely encode each path segment into URLs. Non-UTF8 entries, if unsupported by UI, are explicitly hidden/reported, not misaddressed. Prevent percent/double-decode ambiguity across router and service.
- Central `PolicyService.assert(principal, action, ref)` / `allowedActions` with typed errors. Central `FilesystemService` is the only module that resolves physical paths and opens handles. Public consumers use `stat/list/openRead/createDir/rename/copy/move/delete/stage/commit` with principal and ResourceRef. `openRead` returns an authorized handle, fstat metadata, version and idempotent close/cancel function; downstream download/preview code cannot resolve an independent path. Mutations recheck both ACL and filesystem context, use ordered locks and operation journaling. Freeze exact service signatures at G0.
- Every controller uses an authorization-aware service. Only filesystem internals access `node:fs` for user paths. Auth/admin data files and application assets have separate service ownership. No raw user filesystem path in logs or DTOs; use mount ID, authorized logical path, error code.
- DB tables (logical ownership): `users`, `groups`, `group_members`, `acl_rules`, `mounts`, `sessions`, `shares`, `share_grants` (or session-held grants with explicit revision), `uploads`, `upload_reservations`, `fs_operations`, `digest_cache` (optional), `audit_events`, `preferences`, `settings`; P1 `download_leases`, `favorites`, `trash`, `jobs` if needed. IDs random or stable DB-generated; timestamps UTC; foreign keys/indexes; unique username/alias constraints. No mandatory `files` table. Define schema/migrations once, use parameterized Data Table. Do not store file content in SQLite. DB owner coordinates all migration filenames.
- Store upload sizes/offsets as safe nonnegative integers, checked for `Number.isSafeInteger`; DB INTEGER is 64-bit. Document supported max numeric size rather than letting unsafe arithmetic silently wrap. Bytes in JSON are integers; UTC ISO date strings. Null versus absent fields defined in schemas.

### 12.2 Proposed routes (same origin, typed Remix route map)

Prefer `/_/` as reserved internal namespace, with `/` landing/file manager. Root aliases are one segment, directory shares accept validated descendant segments. Reserve `/_`, `/login`, `/logout`, `/admin`, `/api`, `/assets`, `/healthz`, `/readyz`, `/favicon.ico`, `/robots.txt`, `/.well-known`, and any current/future app/static names; the chosen internal namespace and fixed routes always win. Alias validation rejects conflicts on creation; router must also enforce reserved route priority.

| Method / path | Behavior |
|---|---|
| GET `/` | App shell for signed-in user; login/neutral landing otherwise |
| GET/POST `/login`, POST `/logout` | Official session/credentials flow; CSRF on POST |
| GET `/_/files?mount=...&path=...` | Authorized UI frame/page (query path format frozen at G0) |
| GET `/_/api/v1/entries` | List/stat DTOs, validated resource refs, bounded results |
| POST `/_/api/v1/files/operations` | Mutations: create/rename/copy/move/delete; per-item results for bulk |
| GET/HEAD `/_/download` | Authorized native file response for mount/ref |
| GET/HEAD `/_/preview` | Safe content policy + authorization, range where needed |
| GET/POST `/_/api/v1/shares`, PATCH/DELETE `/_/api/v1/shares/:id` | Authorized alias management |
| POST `/_/shares/:id/unlock` | Password unlock, CSRF, rate limit, scoped session grant |
| OPTIONS/POST `/_/uploads` | Protocol negotiation/creation; authorize target |
| HEAD/PATCH/DELETE `/_/uploads/:id` | Offset, chunk, termination; recheck grant/user |
| GET `/_/events` | Authorized SSE transfer/status events |
| GET `/_/admin/...`, `/_/api/v1/admin/...` | Admin UI/API, role checks; mutations only unsafe methods |
| GET `/healthz`, `/readyz` | Minimal health/status, no sensitive details |
| GET/HEAD `/:alias` and `/:alias/*` | Last dispatch: validate alias + exact scope; file bytes or share view |

- All authenticated file refs use a single URL encoding convention and shared validation, e.g. mount ID plus separately encoded segments or JSON request body for mutations. Never decode a wildcard path twice. G0 choose query encoding + roundtrip tests for spaces, `%`, Unicode, #, ?. Unrepresentable filename cases handled explicitly.
- Proposed error format for JSON controllers: `{ error: { code, message, requestId, details? } }`; never leak internal paths/stack. 400 invalid input, 401 unauthenticated, 403 forbidden or 404 opaque missing/unauthorized resources, 409 conflict/stale upload offset, 413 bounded request too large, 416 unsatisfied range, 429 rate limit (Retry-After), 503 storage unavailable, 507 insufficient storage. Protocol routes use protocol headers/status rather than blindly JSON wrapping; HTML routes accessible errors. Versioned error codes frozen at G0.
- Public aliases: direct file mode sends attachment at `/rd`. Landing mode shows `/rd` page; its download link may be `/rd?download=1` (same alias, no redirect for the download). Folder mode shows listing at `/games/`; file descendants stream directly. Password unlock can redirect to the intended same-origin landing/download route only after validation; no direct-mode redirect for already authorized requests. `HEAD` must not return a landing body or count as a download; define mode-consistent headers. Fixed routes, assets and public catch-all must never shadow one another.

### 12.3 Middleware and auth/transfer semantics

- Boundary: assign request ID, validate origin/host/trusted proxy, enforce safe limits and errors. Static middleware only app-owned assets in fixed namespace; never `/storage`, appdata, cache, staging or node_modules as arbitrary static tree. Official asset server explicitly configured browser modules only; no server sources/secret exposure. Error mapping must not swallow stream errors or leak paths.
- Use Remix session middleware before auth/CSRF, official auth scheme with live account lookup, COP plus session CSRF on unsafe cookie-backed routes, CSP with nonce integrated into renderer. On login/forms, bounded form parsing only where needed before token extraction; on raw upload PATCH, token from header and no form-data middleware. Validate before side effects. Rate limit before expensive parse/hash; trusted peer address from runtime, never blindly forwarded headers. G1 test actual ordering and signed cookies with proxy HTTPS. `cop()` alone allows missing provenance headers; use session CSRF tokens and explicit origin policy, not tokenless protection alone.
- Sessions: implement official `SessionStorage` interface with SQLite read/save and rotation/destroy semantics, expiry, no resurrection from concurrent requests. Compile against installed types instead of copying an unverified signature. Use official `completeAuth` flow and test old session invalidation. Signed cookie holds opaque storage ID, not permission claims. Password shares use scoped revision grants, not user account impersonation. No unauthenticated user can pick a `Principal` from request input.
- Public share usage stats: count successful body responses/ranges and bytes served separately. P1 limited downloads: reserve one lease atomically per share revision + file version + opaque recipient/session identity, allow subsequent matching ranges within TTL without new count, reject beyond budget; expire leases and revalidate on each request. A missing-cookie client may consume another lease; document that exact per-human download counts are not inferable. Do not decrement on HEAD, 304, 416 or failed authentication. Test concurrency and revoked/expired leases. Native direct URL remains valid without app JS. If reliable semantics for no-cookie clients cannot be provided, keep hard download limits disabled until reviewed rather than blocking ordinary resume.

### 12.4 Resumable upload contract (implementation target)

Use tus 1.0.0 Core + Creation, Termination and Expiration only after conformance tests. No concatenation, deferred length or checksum extension unless fully implemented/advertised. Standard headers `Tus-Resumable`, `Upload-Length`, `Upload-Offset`, `Upload-Metadata`, `Location`, `Tus-Version`, `Tus-Extension`, `Upload-Expires` where applicable. Source R10 is authoritative for status/headers/version negotiation; own application auth/metadata validation is layered on top. Do not call a partial implementation compatible with arbitrary tus clients until tested.

- Creation `POST /_/uploads`: bounded metadata identifying authorized mount, parent segments, name and explicit conflict policy; known total length (including zero-byte); check quotas, caps, free space; reserve and allocate opaque ID, stage and DB row. Return 201 and Location. The staging path is generated server-side, never passed from browser.
- `HEAD /_/uploads/:id`: authorization, return authoritative `Upload-Offset` and length, `Cache-Control: no-store`. Clients resume by comparing offset. `PATCH` uses `application/offset+octet-stream`, exact expected offset, request-body streaming, chunk-size bound. Stale/duplicate offsets return 409 without mutation. Serialize per-upload writes; reject illegal negative/overflow offsets or excess total bytes; `204` with new offset only after durable progress. Abort/disconnect policy: rollback unfinished chunk to previous committed offset, or commit a durable prefix and expose it consistently; choose rollback initially for simpler testable semantics. Handle short/partial writes; never trust Content-Length alone.
- `DELETE` cancels active upload, waits for/reconciles writer, deletes stage and releases reservation under lock; idempotent internal cleanup and correct protocol response. Expired upload returns protocol-appropriate 404/410; expiration cleanup cannot delete active chunks. Reauthorize all requests and recheck source/share/ACL at finalization. Owner-disabled sessions cannot finish uploads.
- Persist offset only after staged bytes are written and synced to the extent supported by the filesystem and configured durability policy. On crash between disk and DB, truncate uncommitted staged bytes back to DB offset; if stage shorter than committed offset, mark failed/recover only with proof. SQLite transaction records finalize intent before atomic publication; sync file, and parent directory where supported. No DB transaction stays open across streaming. Recovery must distinguish a successfully published target from an unrelated external file using recorded identity/digest/intent. Never blindly overwrite or repeat finalization after restart. Release reservations only after durable completion/cancel. Crash tests at every boundary; no promise of cross-resource atomic transaction.
- Browser uses File/Blob slices, `XMLHttpRequest` or bounded fetch for upload progress (XHR has standard upload progress; Fetch request streaming compatibility is browser-dependent). Persist only queue metadata in IndexedDB, never assume file handles survive a refresh. On reselection verify size/name/mtime plus cryptographic identity evidence appropriate to resume (at least check already uploaded bytes via stored chunk digests or validate final expected full-file digest); otherwise restart. Upload chunks 8–32 MiB proposed default, max 64 MiB or measured alternative; config limits must match proxy and Bun. User can upload >100 GB by many bounded requests. No giant multipart request or reading whole browser file into memory.

## 13. Repository organization and configuration

Proposed layout; preserve one Remix app and official starter conventions. G0 freezes actual paths. Browser `public/` source layout and asset route follow Remix docs, not a separate frontend build.

```text
/
  AGENTS.md                     # short mandatory rules derived from this spec
  SPEC.md                       # this document
  docs/adr/                     # coordinator decisions and spike results
  server.ts                     # Bun.serve and startup/shutdown
  app/
    router.ts                    # coordinator owns registration
    routes.ts                    # frozen typed route map
    contracts/                   # domain DTOs, schemas, errors, service interfaces
    config/                      # env + validated config
    db/                          # single SQLite client, schema/migrations
    middleware/                  # request, auth, csrf, security, errors
    auth/                        # accounts, sessions, groups, policies
    filesystem/                  # resolver, handles, mutations, locks, journal
    downloads/                   # HTTP file response, digest, transfer state
    uploads/                     # protocol, reservations, staging, recovery
    shares/                      # aliases, scope, grants, public controller
    previews/                    # safe media, cache
    admin/                       # settings, diagnostics, audit
    ui/                          # shared Remix components, styles, layout
    public/                      # explicit browser entries/styles as starter expects
    features/                    # feature controllers/views (co-located)
  public/                        # trusted static assets only
  tests/                         # unit, HTTP, Linux/security, crash, browser checks
  Dockerfile
  compose.yaml
  package.json
  bun.lock
  tsconfig.json
```

- One `createApp(config, services)` composition/root-router factory for testable isolated instances. Server startup validates settings, opens DB, migrates, verifies mounts, runs recovery, builds router and starts Bun. Use `fetch(request, server) { return router.fetch(request) }` conceptually, adapt actual signatures and trusted runtime context. No global side effects/import-time server in unit tests. Set `jsx: "react-jsx"`, `jsxImportSource: "remix/component"` per official docs; this transform name does not add React. Use native assets/rendering; no mandatory separate build. Production source/assets and dependencies are packaged together; use production asset cache/fingerprints and test cold startup/SSR/hydration.
- Config proposal: environment + validated JSON file (no YAML parsing dependency; Docker Compose remains YAML). `PUBLIC_ORIGIN`, `PORT`, `DATA_DIR`, session secret file, bootstrap secret file, trusted proxy CIDRs, max chunk bytes, transfer limits, retention. Storage roots declare ID, label, absolute in-container path, readOnly, expected mount sentinel/identity and staging support. Admin can enable/label configured roots and ACLs, not mount a new arbitrary host path. Never bind database/config to a user root. Secrets generated using cryptographic randomness and persisted across restarts, not regenerated each boot; support rotation/explicit session invalidation.
- Use a local `/app/data` for SQLite and app metadata; separate private `/app/cache` optional. Staging per writable root must be same filesystem, protected by mode/ownership and denied from all file APIs/shares/previews. No exposed temp files. Mount sentinel or equivalent identity required for fail-closed unavailable storage detection; do not auto-create arbitrary missing storage root on startup.
- Example Compose (illustrative; verify image tag, user IDs, mount permissions, secret/bootstrap provisioning before running):

```yaml
services:
  files:
    build: .
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      PUBLIC_ORIGIN: https://dl.lnh.ge
      PORT: "8080"
      DATA_DIR: /app/data
    volumes:
      - ./appdata:/app/data
      - /mnt/storage:/storage
    user: "1000:1000"
    read_only: true
    tmpfs:
      - /tmp
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    restart: unless-stopped
    stop_grace_period: 30s
```

Existing external HTTPS reverse proxy routes to the one server; configure trusted proxy, request body limits (chunk-sized, not entire file), long transfer timeouts, disable buffering/transformation for streams, preserve range/conditional headers and SSE. If proxy is in another container, use appropriate private network instead of assuming host loopback is reachable. No extra required service. Support a direct TLS mode if chosen later. Dockerfile multi-stage if useful, Bun pinned base, frozen install, copy only necessary app source/assets/dependencies, non-root UID/GID, exec-form entrypoint and healthcheck. No runtime package downloads or privileged setup. Test read-only root with asset compiler cache and native modules. Backup data volume plus real files independently.

## 14. Parallel Codex execution plan

### Wave 0 — foundation and spikes (do not skip)

Coordinator owns `package.json`, `bun.lock`, `server.ts`, `app/router.ts`, `app/routes.ts`, contracts, shared migrations and `AGENTS.md`. Start with one short serial bootstrap: validate pins, create minimal runnable Remix/Bun app, actual native JSX/rendering, DB, test runner and route registration; commit base. Freeze interfaces and test fixtures before opening feature worktrees. After bootstrap, run these spikes in parallel, using isolated branches/worktrees and temporary fixture mounts. Record exact code, commands, pinned version, results and failures in `docs/adr/`.

| Gate | Owner / task | Must prove |
|---|---|---|
| G0 | Coordinator / runtime foundation | Bun starts official Remix route, server-rendered interactive component hydrates, asset requests work in production container; native SQLite & Data Table query/migration; actual exports compile, no third-party direct deps |
| G1 | Auth/security spike | Official auth/session/CSRF/CSP on Bun, custom SQLite SessionStorage rotate/revoke/destroy and concurrency tests, raw PATCH CSRF header without body consumption, trusted proxy Secure cookies, browser CSP |
| G2 | Filesystem safety spike | Linux supported-threat-model resolver, safe pinned handle, symlink/hardlink/special-file/rename attack tests, safe no-replace and mount-loss behavior, staging/recovery capabilities; owner accepts documented external-writer trust boundary |
| G3 | Download spike | Actual HTTP requests through Bun + Remix helper with `acceptRanges`, strong streaming digest and unchanged/version-changed resume; HEAD/206/416/304 and Unicode filenames; bounded memory and abort, proxy smoke |
| G4 | Upload spike | Bounded raw PATCH, lock/offset correctness, pause/retry, crash truncate/recovery, atomic final publication with original name, 0 byte and multi-chunk, no overwrite races |
| G5 | UI/runtime optional spike | Official pinned UI primitives, accessible menu/dialog/selection, persistent upload state + native download link bypass; Bun.Image format/limit verification; report optional gaps |

**G0 first.** Agents can develop mocks/unit tests against frozen contracts while G1–G5 run; no production implementation can bypass an unresolved gate. If a gate fails, isolate the failure, propose a narrow adjustment, and get owner approval for any dependency/threat-model/architecture change. Do not merge insecure placeholders. G2 is mandatory before any public exposure, not a TODO to fix later. G3/G4 are mandatory before claiming resumable transfers.

### Wave 1 — parallel implementation workstreams

Branch/worktree naming suggestion `codex/<id>-<name>`. Each workstream has exclusive owned folders, consumes contracts/mocks, writes its own tests and delivers a PR/change summary. No agent modifies package dependencies, route map, shared types or migration numbering independently. Coordinator receives proposed contract changes and merges them once. Use isolated temp DBs/ports and fixtures; do not touch the owner's real data or domain.

| ID | Workstream | Owns / deliverables | Depends on |
|---|---|---|---|
| A | Foundation & integration | `server.ts`, router composition, config, contracts, DB bootstrap, CI, dependency policy, route map | G0; coordinator only |
| B | Accounts & sessions | `app/auth/accounts`, session adapter, login/logout, group model, credentials, reset/bootstrap, revoke, auth tests | G0/G1; DB contract |
| C | Authorization & web security | ACL policy, request middleware, CSRF/COP/CSP integration, rate limiter, trusted proxy, audit/security tests | G0/G1; B identity interface |
| D | Filesystem core | `app/filesystem`, mount registry, resolver/open handle, listing and mutations, lock/journal, conflict tests | G0/G2; C policy contract |
| E | Download engine | `app/downloads`, file response, validators/digest, range/abort/metering, native routes | G0/G3; D handle + C policy interfaces |
| F | Upload engine | `app/uploads`, protocol/offset/staging/recovery/quota reservations, crash tests | G0/G2/G4; D mutation/stage + C policy interfaces |
| G | Shares | `app/shares`, alias DB/revision/scope, public resolver, grants, share tests and public routes | G0/G1; C/D/E/F contracts; F only for upload-only shares |
| H | UI foundation | `app/ui`, browser entry/styles, layout, accessibility tokens/components, auth/public view styles | G0/G5; DTOs; coordinate templates with B/G |
| I | File manager UI | feature browser controllers/views, navigation, list/grid, selection, context actions, search, keyboard | G0/H; D DTO/controller mock |
| J | Transfer UI | transfer queue/client upload protocol, progress/retry/selection, native download actions, SSE client | G0/H; E/F HTTP contract mock |
| K | Share UI | share editor/list, copy alias, direct/landing views, password unlock | G0/H; G route contract mock |
| L | Admin UI/operations | admin views/controllers, user/group/root/ACL/share settings, audit and health | G0/H; B/C/D/G service contracts |
| M | Previews/archives | Safe previews, bounded thumbnails and cache, streaming TAR export, archive listing, and advanced format verification (§11.5) | G0/G5 and C/D/E contracts. Dependency exceptions require owner approval. |
| N | Packaging/reliability | Dockerfile, compose, docs, backup/restore, shutdown/load tests, proxy config examples | G0; A startup contract, D/F recovery |
| O | Independent QA/red team | adversarial HTTP, ACL matrix, race/crash tests, browser manual scenarios, load measurements; review all PRs | G0; integration endpoints as they land |

Workstreams B–O can work concurrently after G0 using frozen interfaces and explicitly test-only mocks; production registration happens only when dependencies and gates pass. Keep all core functionality in the same Remix application, even if different agents own directories. Feature controllers export a registration function or typed controller for coordinator to compose; they do not independently change server or root router. Shared migrations: each owner submits schema proposal; coordinator assigns filenames/order and merges once; CI tests clean install + upgrade. If G1/G2/G3/G4 reveals changed interfaces, freeze new revision and rebase all affected agents before merging.

### Wave 2 — merge and release sequence

1. Merge A and accepted spikes/contracts. CI green, dependency gate clean.
2. Merge B/C/D after G1/G2; verify auth + filesystem integration before routes become exposed.
3. Merge E/F and G with integration contract tests. Verify actual native HTTP transfers and alias resolver, concurrent permissions and state transitions.
4. Merge H/I/J/K/L with the core of M/N. Run browser flows against the real HTTP server using isolated storage. Verify that a recipient can download an unchanged file after interruption.
5. Integrate P1 and P2 work against the accepted core contracts. Exercise upload-only requests, selection shares, archive export, trash and restore, transfer controls, session and token management, previews, and integrations. Record the result for each conditional capability in §16.
6. O independently executes the release suite and documents findings. The coordinator reviews every exposed route and the dependency manifest. The owner accepts the G2 deployment threat model before public exposure. Prepare the release tag, backup and rollout instructions. Do not automatically deploy to the real domain or alter real storage.

### Agent prompt template (copy into each Codex task)

```text
Read docs/FILE_SERVER_BUILD_SPEC.md, PRODUCT.md, AGENTS.md, app/contracts/* and accepted docs/adr/*.
You own workstream <ID> in §14. Work only in your assigned paths and tests.
Use Remix 3.3.0, Bun 1.4.5 and Effect 4.1.7, with official Remix APIs and the application-scoped Effect runtime. Coordinate dependency changes. Verify installed exports and types against the published APIs and record any gaps.
Consume frozen contracts; if blocked, propose an interface change, do not silently change shared files. Use test-only mocks while waiting for other branches. No insecure production stubs. Never touch real user data, production domain or secrets.
Implement the P0, P1, and P2 requirements owned by this workstream in dependency order. Test success, failure, and authorization paths for each enabled feature. Run bun check, bun test, and applicable HTTP/Linux tests. Report exact results, changed files, dependencies, and unresolved gates. Document evidence for each fallback or blocked capability.
```

## 15. Acceptance tests and release gate checklist

Use Bun test and real `Bun.serve` HTTP integration tests on a temporary port and per-test DB/root. Router-level tests alone do not prove wire semantics. Use temporary dirs with Unicode, literal `%`, spaces, `#`, `?`, 0 bytes, nested roots and independent users/groups. Test under Linux inside final image. Use manual Chrome/Firefox desktop/mobile checks or dev-only browser tooling already supported by Bun, no extra production browser. For large tests use sparse files where suitable for offset/range, and real allocated data for throughput/durability; sparse files do not prove disk speed or storage capacity. Record commands/results, hardware, versions and RSS, not just pass/fail claims.

| Test group | Minimum evidence |
|---|---|
| Installation/dependency | Frozen install, type checks/tests, official-only direct deps, clean Docker run as non-root, no Redis/Postgres/Node runtime, SSR + interactive UI works offline (aside from accessing service), single listener |
| Existing disk | Files added externally visible on next list, upload normal final name/contents and path verified with OS, rename/copy/move/delete behavior, Unicode/percent round trips, no hidden app storage leaks |
| Storage failure | Read-only root, ENOSPC, missing/unmounted root not underlying dir, unavailable permission, partial writes, supported SMB/NFS behavior documented, no unsafe fallback |
| Permissions | Matrix users/groups/ancestors/descendants, deny/override semantics, source+dest, bulk/recursive operations, direct endpoint attacks, thumbnails/HEAD/304/archive not bypass, admin boundaries |
| Path security | `../`, encoded/double-encoded path/separator, NUL, ambiguous prefix, symlink intermediate/final, magic links, hardlinks, special files, nested mount, concurrent rename/swap, reserved internals, no unauthorized bytes or mutations |
| Authentication | Bootstrap locked down, invalid login generic error, rate limits, signed cookie tampering, Secure/proxy trust, CSRF login/logout/PATCH/admin, session rotation and concurrent revocation, account disabled/password reset, open redirect rejection |
| Downloads | Correct GET/HEAD, bytes 0-1023, suffix/open-ended, 206 headers, unsatisfied 416, empty file, If-None-Match/304, If-Match/412, If-Range valid and invalid/weak/date, no compression, Unicode filename, unknown unsafe file attachment, no memory buffering, native download pause/resume |
| Downloads large/concurrent | File >100 GB (sparse for range/offset, allocated for measured stream), offsets >2 GiB and >4 GiB, parallel ranges, slow clients/disconnect, handle leak test, RSS bounded, proxy headers and native Chrome/Firefox resume. Changed-file behavior defined and tested |
| Upload protocol | OPTIONS/POST/HEAD/PATCH/DELETE, wrong offsets/version/content-type, missing auth/CSRF, huge/negative/overflow length, actual stream bound, 0-byte, duplicate requests, concurrent writes, retry/pause, folder path traversal, overwrite/rename/skip conflicts |
| Upload crash/restart | Kill process during write, after sync/before DB offset, after offset, before/after publish, before completed DB commit; recover committed offset, no data loss/silent overwrite, reservations reclaimed, final digest matches input |
| Shares | `/rd` returns correct bytes & original filename directly without redirect, unique/reserved alias conflicts, edit/revoke/expire, password rate limit and scoped grant, target revision changes invalidate, unauthorized descendants denied, directory share cannot escape, path replacement policy, no listing hidden shares |
| Selection share | Select items across folders and send one link. Verify that the recipient can download an individual item and the authorized archive. Check that unselected siblings stay private and a permission change applies on the next request. |
| Upload request | Create a folder-targeted link with expiry and a total-size cap. Upload from a signed-out browser, resume an interrupted transfer, and verify the completed file on disk. Check concurrent submissions against the cap, collision privacy, and revocation before completion. |
| File management and administration | Restore a trashed file when its old name is occupied. Verify scoped search, transfer cancellation, quotas, device-session revocation, and token scope and expiry with separate user accounts. |
| Integrations and formats | For each enabled provider, viewer, codec, or archive format, exercise the end-user flow on the supported deployment. Verify the documented fallback for unavailable formats and local login with an external identity provider disabled. |
| Preview/XSS | HTML/SVG/JS attachments, malicious filename/metadata safely escaped, MIME spoofing, CSP asset/hydration works without weakening, thumbnails ACL/cache, max pixel/size/decode limits, text cap, no raw Markdown HTML |
| UI | Accessible keyboard/touch flows, responsiveness, list/grid, context menu, selection, drag/drop fallback, upload queue persists during internal navigation, native download not hijacked, share creation copy, errors/empty states, no secret serialized |
| Reliability | Graceful shutdown + resume, SQLite backup/restore and migration, concurrency/short transactions, audit redaction, mount failure handling, SSE permissions/heartbeat/disconnect, no unsafe dev routes |

Manual HTTP smoke examples against a disposable fixture alias (substitute local origin and authorized cookies; never run against real data without permission):

```sh
curl -I http://127.0.0.1:8080/rd
curl -sS -D - -o /dev/null -H 'Range: bytes=0-1023' http://127.0.0.1:8080/rd
curl -sS -D - -o /dev/null -H 'Range: bytes=-512' http://127.0.0.1:8080/rd
curl -sS -D - -o /dev/null -H 'Range: bytes=999999999999999-' http://127.0.0.1:8080/rd
# For a sufficiently large fixture, first two ranges return 206; the impossible range returns 416.
# Record ETag from HEAD and replay If-Range with same/mismatching values; compare actual bytes.
```

**Definition of done.** Account for each P0, P1, and P2 requirement. Every enabled feature has passing integration coverage. A conditional capability has either verified support, a tested fallback allowed by the spec, or a documented blocker requiring owner resolution. An unresolved mandatory gate blocks release.

G0–G4 and the mandatory parts of G5 pass. The direct dependency allowlist passes. Critical or high security findings require remediation or owner-reviewed disposition. Document the supported threat model, formats, and filesystems. Demonstrate recovery without corruption, backup and restore, native browser download and resume, upload to the original destination path, and direct custom aliases.

## 16. Capability checks and open owner decisions

- Project name, visual identity, exact admin default limits and retention. Initial priorities and route namespace can be changed at G0 before freeze.
- Whether to support hostile external writers beyond the trusted-host/SMB/NFS contract. If yes, a stronger OS confinement design or native helper may be necessary; never weaken security to maintain zero dependencies.
- Exact stable-file/resume policy for externally in-place modified files (trusted publish-by-rename is recommended). Snapshot mode optional and off by default.
- ZIP/ZIP64 export, advanced PDF/Markdown safety, video thumbnails/transcoding, unsupported Linux image codecs, OIDC, WebDAV, quotas for external writers, optional search index. Keep these scoped until native APIs and security are verified; no hidden dependency additions. No passkeys/TOTP by explicit owner decision.
- Browser support matrix beyond recent Chrome/Firefox; test Safari/mobile where feasible. Native resume depends on browser, validators and server/proxy configuration.

## 17. Verification references and limitations

Documentation reviewed on 2026-11-27. Some indexed API pages display older minor versions; exact installed exports/types and source at the pin are the authority. These links document capabilities, not evidence that the proposed implementation already works. The official Remix docs provide Markdown versions and an agent skill; use these and inspect package source in the actual checkout during G0. No Bun executable or npm registry network access was available in the research environment, so **no actual app scaffold, package install, benchmark, or security test was executed for this brief**. Do not treat any runtime gate as passed. Bun and Remix versions above were verified from official public docs/release notes, not a local installation. UI exact version and registry/docker digest remain to be verified. This document is a specification, not generated implementation.

- R1 — [Remix introduction (3.3.0)](https://docs.remix.run/), [API index](https://docs.remix.run/api/), [router](https://docs.remix.run/api/router/), [production guide](https://docs.remix.run/production/). Full-stack model, typed Fetch router and runtime integration. Production guide has unfinished sections; verify actual runtime setup.
- R2 — [Remix files/assets guide](https://docs.remix.run/files-and-assets/), [fs](https://docs.remix.run/api/fs/), [assets](https://docs.remix.run/api/assets/), [file-storage](https://docs.remix.run/api/file-storage/). Native filesystem vs hashed key/value storage, lazy streaming and browser assets.
- R3 — [createFileResponse](https://docs.remix.run/api/response/file/function/createFileResponse/), [FileResponseOptions](https://docs.remix.run/api/response/file/interface/FileResponseOptions/), [response API](https://docs.remix.run/api/response/). Range defaults, weak/strong validators, custom digest and compression implications.
- R4 — [Remix auth](https://docs.remix.run/api/auth/), [auth middleware](https://docs.remix.run/api/middleware/auth/), [session](https://docs.remix.run/api/session/), [session middleware](https://docs.remix.run/api/middleware/session/), [session storage](https://docs.remix.run/api/session-storage/). Official credentials, sessions and app-owned storage integration.
- R5 — [CSRF](https://docs.remix.run/api/middleware/csrf/), [COP](https://docs.remix.run/api/middleware/cop/), [CSP](https://docs.remix.run/api/middleware/csp/), [CORS](https://docs.remix.run/api/middleware/cors/), [form data parser](https://docs.remix.run/api/form-data-parser/). Middleware behavior and limitations.
- R6 — [Remix SQLite adapter](https://docs.remix.run/api/data-table/sqlite/), [Bun SQLite](https://bun.com/docs/runtime/sqlite), [SQLite backup](https://www.sqlite.org/backup.html), [SQLite WAL](https://www.sqlite.org/wal.html). Native client, durability, migration and local-db constraints.
- R7 — [Remix Component](https://docs.remix.run/api/component/), [official UI primitives](https://docs.remix.run/api/ui/). Closure-based JSX, explicit updates, hydration and independently versioned unstable UI package.
- R8 — [Bun 1.4.5 security release](https://bun.com/blog/bun-v1.4.5), [Bun release index](https://bun.com/blog), [Bun tooling](https://bun.com/docs), [HTTP server](https://bun.com/docs/runtime/http/server), [file I/O](https://bun.com/docs/runtime/file-io), [password API](https://bun.com/reference/globals/bun/Password), [FFI warning](https://bun.com/docs/runtime/ffi). Pin security release, native server limits/streaming, hashing and native interop limitations.
- R9 — [Bun Image](https://bun.com/docs/runtime/image), [Archive](https://bun.com/docs/runtime/archive), [Markdown](https://bun.com/docs/runtime/markdown), [WebView](https://bun.com/docs/runtime/webview). Native image formats/limits, TAR API, Markdown and experimental dev browser automation.
- R10 — [tus 1.0.0 protocol](https://tus.io/protocols/resumable-upload), [RFC 9110 HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html), [RFC 6266 Content-Disposition](https://www.rfc-editor.org/rfc/rfc6266), [RFC 8187 encoded parameters](https://www.rfc-editor.org/rfc/rfc8187). Protocol correctness and native file download semantics.
- R11 — [Linux openat2](https://man7.org/linux/man-pages/man2/openat2.2.html), [Bun Node-compatible fs.open](https://bun.com/reference/node/fs/open). Distinguish path validation from OS-enforced resolution; actual Bun/Linux confinement is a required spike.

**Final rule:** build a single real Remix application first. The product must be secure, filesystem-native, reliable and easy to use. If a documented framework API does not meet a hard requirement, prove the gap, implement the smallest safe extension, and ask before relaxing the dependency or security constraints.
