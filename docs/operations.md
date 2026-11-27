# Operating lshare

## Initialize a host

Use Bun 1.4.5 and a local Linux filesystem for application metadata. Choose an unused state directory outside the repository and outside every served filesystem root. Run initialization as the account that will own the files. The Compose example defaults to UID and GID 1000. Set `FILES_UID` and `FILES_GID` to the service account when different.

```sh
bun install --frozen-lockfile
export FILES_STATE=/srv/fileserver-state
bun scripts/ops.ts init "$FILES_STATE" operator --container
```

The command creates a sample writable storage directory, its mount identity marker, a signing key, and a random first-use password in the private file `config/bootstrap.json`. Read that file from the host when logging in as the first administrator. Keep it protected until the first account exists, then move it to secure storage or remove it. The app reads bootstrap credentials only when the account table is empty.

The supplied container serves the initialized storage at `/srv/files`. To serve additional existing folders, configure separate bind mounts with `create_host_path: false`, choose non-overlapping container paths, and add an entry to `config/mounts.json` for each. Each record has `id`, `label`, `path`, `readOnly`, and `sentinel`. Place the same sentinel string in a regular file named `.fileserver-root` on the intended mounted volume. Prepare this marker on the writable host before attaching a read-only mount. Keep metadata, backup files, and signing secrets outside every shared root.

Set the workspace name in Administration. To use your own logo and favicon, place a PNG up to 512 × 512 pixels and 256 KiB outside all shared roots, set `BRAND_ICON_FILE` to its absolute path and restart. With Compose, place the image in the host's `config` directory and use its container path, for example `/etc/fileserver/workspace.png`. The same icon appears on signed-in and recipient pages.

## Start and stop

Set the HTTPS origin that the external reverse proxy exposes. The following launch binds the container's one HTTP port to host loopback. The image pins the multiarchitecture Bun base by digest, installs production dependencies from the frozen lockfile, and bundles both the server and browser assets during the image build. To prepare an equivalent local release, run `bun run build` and start `bun run dist/app/server.js` with the configured environment.

```sh
export PUBLIC_ORIGIN=https://files.example.org
docker compose up --build -d
docker compose ps
docker compose logs --tail=40 files
docker compose stop
```

When the build environment uses an HTTPS proxy with a private signing CA, pass the CA as a BuildKit secret while building the image. It is available during dependency installation only.

```sh
docker build --secret id=registry_ca,src="$NODE_EXTRA_CA_CERTS" -t fileserver:check .
```

Use the image in a private deployment only after the applicable [release gates](FILE_SERVER_BUILD_SPEC.md) pass. The configured model trusts the host, mount providers, and other local writers. Publish external updates by atomic rename. Check filesystem guarantees separately on each SMB or NFS mount. Bind remote storage into the container with the intended mount identity, and monitor availability. Storage contents and metadata require separate backups.

Configure TLS termination and pass the original public Host header to the service. Disable intermediary caching, response compression, and upload/download buffering on transfer routes. Allow at least the configured chunk size per request. Test the deployed proxy's byte ranges, limits, timeouts, and response to a slow or disconnected client. Public health checks should expose status only. `/healthz` indicates process liveness, and `/readyz` is the readiness probe. Check the admin storage view for per-root failures.

For a local process, initialize without `--container` so the generated mount configuration points at the real local path. Set `CONFIG_FILE` to the generated `config/mounts.json`, `DATA_DIR` to `data/`, `SESSION_SECRET_FILE` to `config/session.key`, and `BOOTSTRAP_FILE` to `config/bootstrap.json`. Set `PUBLIC_ORIGIN=http://127.0.0.1:8080`, then run `bun run start`.

## Inspect shared content

The file inspection view renders up to 64 KiB of UTF-8 Markdown, text, or supported source as text. Remote links and images in Markdown stay inert. HTML, SVG, JavaScript, and binary files are available through the ordinary download action. The archive view inspects simple uncompressed USTAR headers, reading up to 1,000 members and 128 KiB of names in archives up to 4 TiB. Extended PAX/GNU records, links, special files, and unsupported archive formats use the original-file download. Archive inspection never extracts entries.

## Back up and restore

Create synchronized backups of ordinary user files, hidden per-root trash and staging data, and application metadata. For a backup spanning all volumes, put the service in maintenance by stopping it and pausing trusted external writers. Use filesystem snapshots or a host backup tool for each storage root. Preserve names, permissions, reserved folders, and mount markers.

```sh
bun scripts/ops.ts backup "$FILES_STATE" /secure-backups/fileserver-2026-11-27
bun scripts/ops.ts restore /secure-backups/fileserver-2026-11-27 /srv/restored-fileserver
```

The backup command creates a consistent SQLite snapshot with `VACUUM INTO`, checks database integrity, and records SHA-256 checksums for the database, signing key, and mount configuration. It also works against an active WAL database for a point-in-time metadata snapshot. Protect snapshots with the same access controls as the service's signing key. Store them on a separate volume outside served roots.

Restore requires a new destination directory. It verifies the manifest and database, writes a fresh `data/` and `config/`, and preserves previous state for rollback. Restore the matching filesystem snapshots separately, then verify every mount's path and sentinel. In Compose, set `FILES_STATE` to the restored directory and `FILES_STORAGE` to the restored storage volume. Examine users, grants, and aliases before reopening access. An older snapshot can restore policies active at the time it was taken, including sessions and shares that were subsequently revoked.

## Validation

The [build specification](FILE_SERVER_BUILD_SPEC.md) and [Effect addendum](EFFECT_SPEC.md) define release gates. Run `bun run quality` during development. Run `bun run release:check` for the comprehensive pass. CI builds the same image on Linux amd64 and arm64, runs the native suite, and checks a restart with temporary storage. The weekly and manually dispatched jobs run the broader validation. The ChatGPT agent test needs an e2e login on the runner that executes it. A fresh hosted runner needs an authorized model-provider setup before that gate can pass.

The disposable E2E wrapper creates a temporary SQLite database, root, credentials, and shareable file. It starts the server on loopback, runs the requested tests, and removes the instance. Run `bun run test:e2e:fixture tests/example.e2e.ts` for the browser smoke check, or `bun run test:e2e:fixture` for the full browser suite after signing in. See the [test setup](../tests/README.md).

`bun run coverage` measures all production TypeScript, TSX and browser JavaScript with IstanbulJS under the pinned Bun runtime and Chromium. It includes the real browser handoff by default. Set `FILESERVER_COVERAGE_DETERMINISTIC=1` for a run without subscription-dependent tests. Open `.quality/coverage/index.html` for the annotated source or inspect `.quality/coverage/evidence.json` for inputs, failed suites and missing process or browser measurements. The thresholds are 90% line coverage and 85% branch coverage.

`bun run mutation` selects changed production modules against `MUTATION_BASE` (defaults to `HEAD`, including untracked files). `bun run mutation:all` runs the entire production module set. Stryker uses the Bun test command runner and retains an incremental cache and JSON report in `.quality/mutation/`. Review individual survivors and uncovered mutants in identity, filesystem, share, and transfer modules. Record any claim of an equivalent mutant with its code, location, version, and review evidence. CI distributes complete modules over up to twelve workers and checks the combined Stryker score against 85%. The command runner reports the native suite as a single test. Its incremental cache is keyed by the source, tests, configuration, runtime and selected modules, so changed assertions invalidate old results. Each report records its exact inputs and source. The final gate rejects missing shards, duplicate inputs, mismatched sources and critical survivors. Download the per-shard artifacts for diagnosis.

`bun run test:performance` reads high offsets from a sparse file and streams allocated file bytes to concurrent HTTP clients. The report names runtime, architecture, bytes, elapsed time, and sampled process RSS. The release command also runs `FILESERVER_LARGE_RANGE=1 bun test tests/transfers-large.test.ts`, verifying a cold whole-file digest and a real HTTP range read above 100 GiB. Allow extra time for that disk read. Sparse offsets verify addressability. Use fully allocated representative files on the actual deployment to measure throughput. Re-run after changes to the filesystem, network, reverse proxy, or runtime.

## Upgrade or roll back

Back up metadata and storage before the upgrade. Build the pinned image, restore the backup into an isolated instance with matching storage copies, and run the release gates before switching the live service. Keep the previous image digest and snapshots until the new version has served verified handoffs. If a migration changed the database layout, roll back using the previous image and its matching snapshots.
