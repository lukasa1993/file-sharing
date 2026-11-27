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

## Sign in with OpenID Connect

To enable a provider, register a confidential web client with the exact redirect URI `https://files.example.org/_/auth/oidc/callback`, substituting your `PUBLIC_ORIGIN`. Configure the provider to support the authorization code flow, S256 PKCE, the `openid` scope, `client_secret_post` client authentication and RS256 ID tokens. The issuer must publish discovery metadata with authorization, token, UserInfo and JWKS endpoints. The server requires HTTPS for a remote issuer. A disposable loopback deployment may use HTTP for both the app and its local issuer.

Create each local account in Administration. Obtain its stable subject identifier from the provider for the registered client and add the following top-level member to `config/mounts.json` alongside `mounts`.

```json
{
  "oidc": {
    "issuer": "https://id.example.org",
    "clientId": "files",
    "clientSecretFile": "/etc/fileserver/oidc-client.secret",
    "accounts": [{ "subject": "provider-stable-subject", "username": "sam" }]
  }
}
```

Write the client secret to the named owner-readable file with mode `0600`, outside every served root. Mount it into the container with the service account as the owner. Restart the service after changing settings. Keep the issuer, client registration and mappings together when backing up or moving the installation. Restoring the OIDC client secret requires its own backup or secret manager.

The login page offers both local password and identity-provider sign-in. A verified issuer and subject select an enabled local account and its existing grants. Unmapped identities return to the local sign-in form. To end access immediately, disable the local account in Administration and revoke its active sessions. Removing a mapping takes effect on subsequent external sign-ins.

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

## Delegate folder permissions

In Administration, grant a member `list`, `manage` and the actions they may give to others on the intended folder. The member opens that folder and chooses **Manage folder permissions**. Recipients can find their own account ID and the IDs of groups they belong to under **Account → Folder permission IDs**. The manager uses the recipient ID to grant an action or withdraw a permission they issued there.

Each delegated permission applies to the selected folder and descendants. At each access, the service checks the manager’s current administrator-assigned authority on both the originating folder and the requested item. Explicit administrator rules and private homes take precedence. Delegation confers no authority to change workspace administration or issue management rights.

## Check the production image locally

Build the image with `docker build -t fileserver:check .`. With Docker, OpenSSL and NGINX available on the test host, run `bun run test:container:tls`. The check creates a private volume, invokes the image’s operator CLI, signs in through verified local HTTPS, resumes a two-chunk upload, checks the recipient’s range responses against the original file bytes, and revokes the link. It removes the temporary service, certificate and data on exit.

Set `NGINX_BIN` to the NGINX executable and `LSHARE_IMAGE` to use a different local image tag. On hosts where a rootless daemon publishes TCP ports in a separate namespace, set `LSHARE_PROXY_SOCKET=1` to carry the proxy upstream through a private Unix socket. For an ARM64 image on an amd64 test host, set `QEMU_AARCH64` to a static local QEMU user-mode executable. This exercises the ARM64 Bun runtime on the host kernel under emulation.

Recursive filename searches admit one active scan per account and two across the service. An account can start twelve scans per minute, with a combined ceiling of 120. Scans yield the mount between directories so ordinary file operations can proceed. Narrow the starting folder when the entry limit is reached.

## Account transfer limits

In Administration, use **Set transfer bandwidth** to assign an account a combined upload and download allowance in bytes per second. Direct downloads, previews, archives, upload chunks and signed-in share transfers draw from the same account allowance. A recipient’s transfer can also draw from a shared link’s bandwidth allowance. Each budget allows a small initial transfer of up to approximately one eighth of a second. Changes are applied at the next metering interval to active streams. Leaving the field blank restores unlimited account bandwidth. The deployment’s per-transfer rate can still apply.

The account profile and the Users table show published upload bytes, the account’s quota, and outstanding reservations. A new upload reserves its full declared size. Publication moves its bytes from reserved to used, and a verified permanent deletion of a tracked file releases its charge. Files in trash remain charged. These counters cover uploads made under the account. Files delivered through an upload request use the link’s separate receipt limit. External filesystem writes require separate capacity monitoring.

## Configure preview and staging limits

Administrators can change these values in **Administration → Settings → Preview and staging limits**. The workspace saves a validated set of limits in SQLite and applies it immediately. Existing databases use the defaults until an administrator saves a change.

| Setting | Default | Allowed values |
| --- | ---: | --- |
| Text preview and edit size | 256 KiB | 1–1,024 KiB |
| Formatted text size | 64 KiB | 1–128 KiB, subject to the text preview limit |
| Raster input size | 16 MiB | 1–16 MiB |
| Decoded raster size | 16,000,000 pixels | 1–16,000,000 pixels |
| Archive preview length | 1,000 entries | 1–1,000 entries |
| Maximum size per upload | Unlimited | Zero for unlimited, or a byte count |
| Staging capacity per storage root | Unlimited | Zero for unlimited, or a byte count |

Each new upload reserves its entire declared size against the root’s staging capacity, including incoming file requests. Completion, cancellation or expiry cleanup releases the reservation. Lowering either staging limit affects new reservations. Account quotas, share allowances and free disk space continue to apply. Original downloads remain available when a preview exceeds its configured limits. An unsupported thumbnail returns HTTP 415 with an empty body. The browser checks preview availability using a bounded HEAD probe before requesting content.

## Inspect shared content

Owners can choose **Download TAR** or **Download TAR.GZ** from a folder's actions or the selection toolbar. Recipients see both choices on shared folders and selections. TAR.GZ applies gzip compression as the server streams the archive. Both exports preserve folder names and file bytes. An interrupted archive download starts again from the beginning.

With the default limits, the file inspection view formats up to 64 KiB of UTF-8 Markdown, plain text, or supported source code. Remote links and images in Markdown stay inert. HTML, SVG, JavaScript, and binary files are available through the ordinary download action. The archive view inspects simple uncompressed USTAR headers, reading up to 1,000 members and 128 KiB of names in archives up to 4 TiB. Extended PAX/GNU records, links, special files, and unsupported archive formats use the original-file download. Archive inspection never extracts entries.

The Linux server produces bounded WebP previews for JPEG, PNG, WebP, GIF and BMP images. Its Bun 1.4.5 codecs leave HEIC and AVIF available as original-file downloads. Firefox can open a downloaded AVIF in its local image viewer according to the browser’s file handling preferences. The browser plays audio and video directly when it supports their codecs. Files it cannot play, PDFs, and office documents retain the original-file download.

## Back up and restore

Create synchronized backups of ordinary user files, hidden per-root trash and staging data, and application metadata. For a backup spanning all volumes, put the service in maintenance by stopping it and pausing trusted external writers. Use filesystem snapshots or a host backup tool for each storage root. Preserve names, permissions, reserved folders, and mount markers.

```sh
bun scripts/ops.ts backup "$FILES_STATE" /secure-backups/fileserver-2026-11-27
bun scripts/ops.ts restore /secure-backups/fileserver-2026-11-27 /srv/restored-fileserver
```

The backup command creates a consistent SQLite snapshot with `VACUUM INTO`, checks database integrity, and records SHA-256 checksums for the database, signing key, and mount configuration. It also works against an active WAL database for a point-in-time metadata snapshot. Protect snapshots with the same access controls as the service's signing key. Store them on a separate volume outside served roots.

Restore requires a new destination directory. It verifies the manifest and database, writes a fresh `data/` and `config/`, and preserves previous state for rollback. Restore the matching filesystem snapshots separately, then verify every mount's path and sentinel. In Compose, set `FILES_STATE` to the restored directory and `FILES_STORAGE` to the restored storage volume. Examine users, grants, and aliases before reopening access. An older snapshot can restore policies active at the time it was taken, including sessions and shares that were subsequently revoked.

### Restore an ordinary copy of storage

File and folder shares normally pin filesystem identity. A filesystem snapshot that retains those identities can use the metadata-only procedure above. When the host backup recreates files or directories with new inodes, create a portable metadata snapshot during the same maintenance window as the storage copy.

1. Stop the service and pause external writers. Keep the live service and operator on the same private state volume. Ensure every configured mount is visible at its configured absolute path in the operator's environment. For a container path such as `/srv/files`, run the operator inside a container with the corresponding bind mount.
2. Copy each root in its entirety, including `.fileserver-root`, `.fileserver-internal`, empty directories, file permissions and numeric owners. Run the following command during the same pause. It streams a SHA-256 digest for every ordinary file, including partially uploaded data, and records the complete directory inventory in the metadata snapshot. Plan for one full read of every mount.
3. To recover, put the matching copies at their configured paths before running restore. Keep writers stopped through verification. Restore reads every copied file, checks the exact set of paths and permissions, and binds valid share, trash and quota records to the verified replacement identities. A missing, substituted or extra entry stops the restore. Targets already stale when backed up stay unavailable.
4. Start the service with the restored private state and its original public origin. Validate a recipient link, account access, and the offset of any pending upload before reopening traffic.

```sh
bun scripts/ops.ts backup "$FILES_STATE" /secure-backups/fileserver-portable --portable
bun scripts/ops.ts restore /secure-backups/fileserver-portable /srv/restored-fileserver
```

The portable procedure supports the application's Linux storage model of regular single-link files, directories, and UTF-8 names. Each configured root must have its own matching sentinel. Nested mounts, symbolic links, hard-linked files and special nodes stop verification. Allow space in the destination for the metadata, inventory and temporary SQLite work. Use a fresh destination after interrupting an operator command. Only a completed snapshot contains its final manifest. Metadata-only backups taken by older versions retain their original identity pins. An owner can reconfirm a verified replacement from **Shared links → Edit → Change or reconfirm shared items**. Environment settings and separately configured assets such as the branding image or OIDC client secret belong in the deployment's own configuration backup.

## Validation

The [build specification](FILE_SERVER_BUILD_SPEC.md) and [Effect addendum](EFFECT_SPEC.md) define release gates. Run `bun run quality` during development. Run `bun run release:check` for the comprehensive pass. CI builds the same image on Linux amd64 and arm64, runs the native suite, and checks a restart with temporary storage. The weekly and manually dispatched jobs run the broader validation. The ChatGPT agent test needs an e2e login on the runner that executes it. A fresh hosted runner needs an authorized model-provider setup before that gate can pass.

The disposable E2E wrapper creates a temporary SQLite database, root, credentials, and shareable file. It starts the server on loopback, runs the requested tests, and removes the instance. Run `bun run test:e2e:fixture tests/example.e2e.ts` for the browser smoke check, or `bun run test:e2e:fixture` for the full browser suite after signing in. See the [test setup](../tests/README.md).

`bun run coverage` measures all production TypeScript, TSX and browser JavaScript with IstanbulJS under the pinned Bun runtime and Chromium. It includes the real browser handoff by default. Set `FILESERVER_COVERAGE_DETERMINISTIC=1` for a run without subscription-dependent tests. Open `.quality/coverage/index.html` for the annotated source or inspect `.quality/coverage/evidence.json` for inputs, failed suites and missing process or browser measurements. The thresholds are 90% line coverage and 85% branch coverage.

`bun run mutation` checks changed production modules against `MUTATION_BASE`, which defaults to HEAD and includes untracked files. `bun run mutation:all` selects the entire production surface. The Stryker runner first observes which native and deterministic browser suites execute each candidate. It runs the covering suites until an assertion kills the mutation or the covering suites finish. Each finished candidate is recorded locally. Incremental results are keyed by source, tests, configuration, runtime and selected modules. The combined report rejects missing shards, duplicate inputs, mismatched source, aggregate scores below 85%, and unreviewed critical survivors.

Use Bun’s native `bun pm licenses --prod --json` to export the installed production license inventory and `bun audit` to inspect advisories.

`bun run test:performance` reads high offsets from a sparse file and streams allocated file bytes to concurrent HTTP clients. The report names runtime, architecture, bytes, elapsed time, and sampled process RSS. The release command also runs `FILESERVER_LARGE_RANGE=1 bun test tests/transfers-large.test.ts`, verifying a cold whole-file digest and a real HTTP range read above 100 GiB. Allow extra time for that disk read. Sparse offsets verify addressability. Use fully allocated representative files on the actual deployment to measure throughput. Re-run after changes to the filesystem, network, reverse proxy, or runtime.

## Upgrade or roll back

Back up metadata and storage before the upgrade. Build the pinned image, restore the backup into an isolated instance with matching storage copies, and run the release gates before switching the live service. Keep the previous image digest and snapshots until the new version has served verified handoffs. If a migration changed the database layout, roll back using the previous image and its matching snapshots.
