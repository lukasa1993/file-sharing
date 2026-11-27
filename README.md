# lshare

lshare shares ordinary files from existing storage roots. An owner can create a short download link, share selected items, or request uploads into a folder. Recipients can use the link in a browser. Files remain accessible to trusted applications on the host.

## Deployment profiles

Select the build with `LSHARE_PROFILE=selfhost` or `LSHARE_PROFILE=cloudflare` and run `bun run build`. Self-hosting is the default. The explicit build commands below also select a profile.

| Profile | Build and run | Storage |
| --- | --- | --- |
| Self-hosted | `bun run build:selfhost`, then `bun dist/app/server.js` with the settings below | Existing filesystem mounts and local SQLite |
| Cloudflare | `bun run build:cloudflare` validates the deployment bundle. `bun run cloud:deploy` publishes the configured Worker. | Verified-email accounts, a SQLite Durable Object, direct browser transfers to a private R2 bucket |

The cloud profile targets `dl.ldev.cloud` and accepts files up to 100 MB for 30 days. It emails the operator at 3.6 GB and caps stored plus reserved data at 4 GB. You can deploy using GitHub Actions with private environment secrets. See the [Cloudflare operator guide](docs/cloudflare.md) and the [shared transfer API](docs/transfer-api.md).

## Local development

Use Bun 1.4.5 on Linux. Initialize disposable storage outside the checkout:

```sh
bun install --frozen-lockfile
bun run ops init /tmp/lshare-dev owner
export CONFIG_FILE=/tmp/lshare-dev/config/mounts.json
export DATA_DIR=/tmp/lshare-dev/data
export SESSION_SECRET_FILE=/tmp/lshare-dev/config/session.key
export BOOTSTRAP_FILE=/tmp/lshare-dev/config/bootstrap.json
export PUBLIC_ORIGIN=http://127.0.0.1:8080
bun run dev
```

Open the loopback address and sign in with the credentials in the private bootstrap file. Place files in the initialized storage directory or configure an existing mount. Mount identity markers, backup and restore, production container settings and the supported external-writer model are described in the [operator guide](docs/operations.md).

## Validation

`bun run quality` runs development validation. `bun run release:check` adds the expensive checks. `bun run test:e2e:fixture` starts a disposable real server and runs the headless browser suite. Use `bun run test:e2e:packaged` to exercise the compiled server and browser assets. Agent steps use the configured ChatGPT sign-in. See the [browser test guide](tests/README.md).

The [specification](SPEC.md) ties the user workflows to the implementation requirements. See [architecture and release evidence](docs/implementation-status.md) for supported behaviors, verification results, and open gates.
