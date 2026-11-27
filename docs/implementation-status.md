# Implementation and release evidence

## Architecture

One Bun 1.4.5 process serves Remix 3.3.0 routes, native Remix components, and the file-transfer endpoints. Effect 4.1.7 is the runtime dependency approved by the architecture addendum. SQLite stores metadata. Each configured mount retains its own file tree, marker and private staging area. The formatter, TypeScript declarations, Effect language service, mutation framework and browser runner are development dependencies. [Architecture addendum](EFFECT_SPEC.md)

The managed Effect runtime owns the SQLite connection, domain service layers, bounded transfer-event publication and maintenance fibers. The Remix boundary translates typed failures to HTTP responses. Downloads retain their authorized file handles until consuming or cancelling the response. Uploads persist their confirmed offsets and coordinate final publication with filesystem mutations. Share capabilities carry their owner's current permissions, revision and target identity.

The HTTP listener uses Bun's `node:http` implementation and the official `remix/node-fetch-server` adapter in the same Bun process. Wire tests found that `Bun.serve` discarded an explicit `Content-Length` on streamed downloads. The Remix adapter preserves range framing, forwards disconnects to the request and applies backpressure to the response body. The listener suspends its idle timeout during an admitted transfer's checksum calculation and restores it for delivery. Set the upstream proxy timeout to allow a cold hash of the largest supported file.

Time-sensitive tests use Effect's `TestClock` under Bun's native runner. Session and share expiry, upload cleanup, trash retention, password-attempt limits, bounded SQLite startup backoff, and the scheduled maintenance worker can be exercised without waiting for wall-clock expiry. Administrator diagnostics expose application-scoped Effect counters, active transfer rate, uptime and resident memory. The export omits filenames, host paths, user identifiers and credentials.

## Coverage tooling

The pinned Bun release records lines and functions. Its LCOV generator explicitly omits branch counters. Effect's maintainers publish `@effect/vitest` as a Vitest integration. It does not supply a branch profiler for JavaScriptCore or run the Bun-specific SQLite and HTTP paths under V8. This project uses the Effect maintainers' testing APIs from the existing `effect` package. The branch gate returns a failure when measurements are unavailable. [Bun LCOV source](https://github.com/oven-sh/bun/blob/bun-v1.4.5/src/sourcemap_jsc/CodeCoverage.rs#L519-L522) · [Effect testing integration](https://www.npmjs.com/package/@effect/vitest)

## Local verification

These measurements come from the Codex Cloud Linux amd64 runner. The fixtures used temporary files and SQLite databases.

| Check | Observed result |
| --- | --- |
| Native suite | All 173 Bun tests passed across 18 files, with 1,474 assertions. This includes four forced process exits at different upload write and publication boundaries. |
| Browser handoff | Both Chromium e2e tests passed with action replay disabled and the ChatGPT subscription model. The handoff checked the copied link, signed-out access, filename, and downloaded bytes. |
| Upload restart | After a forced process exit, the replacement process accepted the saved session, reported offset 7,129, rejected a stale offset, and returned all 16,387 original bytes after completion. Chromium also resumed a transfer after the server reduced its maximum chunk size. |
| Database contention | A separate SQLite connection held a write transaction through server startup. After it committed, the service retained the write and created one administrator and one bootstrap audit entry. |
| Native streaming | Three simultaneous clients received matching hashes for 32 MiB each. The production HTTP adapter supplied the declared response length. The isolated run took 486 ms with sampled process RSS growth of 39,424,000 bytes. |
| Large-file range | A real HTTP range at byte offset 108,447,924,224 in a sparse file returned HTTP 206, the correct 21 bytes and a content length of 21. A subsequent HEAD returned the original size and the same strong ETag. The cold SHA-256 pass and both requests took 272.4 seconds on the four-CPU cloud runner with 10.1 MiB sampled RSS growth. |
| Coverage | Native LCOV recorded 8,440 of 9,076 lines in the production modules it loaded (93.0%). It omitted the server entry point and five browser modules, and contained no branch counters. The coverage command returned failure as configured. Some critical lines remain uncovered. |
| Mutation testing | All 157 session-storage mutants and all 85 proxy-trust mutants were killed, with all default mutation operators enabled. A broader development snapshot generated 11,907 mutants. That run stopped after subsequent code changes invalidated the snapshot. A complete score for the integrated project remains outstanding. CI is configured to combine twelve disjoint groups and reject stale or missing reports. |
| Static and dependency checks | The production build, strict TypeScript, formatting, lint and official Effect CLI and editor checks passed. Bun reported zero high or critical package advisories. Its all-severity audit listed five moderate development findings and one low transitive production finding in esbuild's Windows development server. |
| Container | The Linux amd64 image served HTTP with a read-only root and a non-root user and restarted against existing state after removal of the bootstrap file. Native arm64 is configured in CI and awaits execution. |

The coverage and full-project mutation requirements remain open. The deployment-specific acceptance checks also require the intended reverse proxy, mount types, browsers and fully allocated large files. The local volume has 63 GiB capacity. Sparse offsets and separate concurrent transfers cover different cases from a complete 100 GiB upload or download.

## Supported behavior and boundaries

- **Host storage.** Linux mount IDs and pinned directory handles form the confinement boundary. The host controls mount definitions and external writers. SMB/NFS semantics and durability must be verified on the actual deployment. External edits should publish by rename for safe download resumption.
- **Sharing.** Single-file aliases can stream immediately or open a landing page. Folder and selection shares confine access to the chosen entries. An upload-only recipient has a folder-scoped capability. Public aliases require explicit confirmation. Accounting measures served bytes and transfer leases. A move that invalidates a target leaves the share unavailable until its owner updates it.
- **Previews and archives.** The browser can download original files. Verified formats have bounded preview paths. TAR/TAR.GZ export streams entries. ZIP/ZIP64 export, advanced office/PDF, and video transcoding require capabilities outside the verified stack. Unsupported formats retain the ordinary download path.
- **Accounts.** Local accounts, groups, private homes, server sessions, and scoped tokens are implemented. The pinned Remix OIDC helper does not verify all required ID-token claims and signatures. External provider sign-in remains gated on an approved verification path. Passkeys and TOTP are outside the agreed scope.
- **Quotas.** Upload reservations account for in-progress and published uploads. The application rechecks the current allowance before publication. Trashing an upload retains its charge. A verified permanent deletion or trash purge credits an upload whose filesystem identity was recorded. External changes, cross-root moves, overwrites, legacy rows and filesystems without a reliable birth time can retain charges. Share upload limits count cumulative receipts. Copies, external writers and on-disk usage require independent capacity controls. These limits apply to uploads and are separate from filesystem quotas.
- **Operator decisions.** Public deployment requires acceptance of the external-writer trust model, validation on the intended filesystems and hardware, and the release checks in both specifications. No production domain or real user storage is provisioned as part of development.
