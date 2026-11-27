# Browser tests in Codex Cloud

From this repository, ask Codex to run the browser tests. The fixture command starts the real server on a free loopback port and creates a temporary storage mount, SQLite database, owner account and file. It removes them when the tests finish.

```sh
bun run test:e2e:fixture --no-cache
```

The Chromium journeys cover file and folder management, shares and upload requests, transfer recovery, previews and archives, accounts, administration, display preferences, and keyboard and mobile interactions. The owner setup authenticates once per run. Each test receives its own browser context; the server uses temporary files, generated credentials, and a fresh SQLite database. The live ChatGPT handoff checks the copied share URL, the recipient’s download filename, and the exact bytes of [handoff.txt](fixtures/handoff.txt).

The fixture also starts a disposable OpenID Connect issuer on a second loopback origin for the mapped and unmapped sign-in journeys in `tests/oidc.e2e.ts`. These two cases are enabled by the local fixture wrapper. Run `bun run test:e2e:fixture --packaged --local-auth-only tests/oidc.e2e.ts` to verify local password sign-in with provider configuration and integration disabled. Running against an externally supplied `APP_URL` uses the deployment’s own sign-in configuration.

Run the deterministic journeys with `bun run test:e2e:fixture --exclude-tag agent`. Run just one flow by passing its test file to the same command. For Firefox, install the matching binary with `bun run e2e-web install firefox --with-deps` and set `E2E_BROWSER=firefox` when launching the fixture.

Agent steps use a ChatGPT subscription and default to `gpt-6-luna`. Set `E2E_CHATGPT_MODEL` to select another model available to the subscription. On a fresh workspace, Codex runs the setup commands and starts device sign-in. The account owner opens the displayed verification link and approves the code on their own device. The credential stays outside the repository.

```sh
bun install --frozen-lockfile
bun run e2e-web install chromium --with-deps
NODE_USE_ENV_PROXY=1 npx e2e login openai --device
```

The runner uses Node 24.8 or later and Bun 1.4.5. In a cloud image with npm and no Bun on the path, run the fixture with `npx --yes --package=bun@1.4.5 -- bun run test:e2e:fixture --no-cache`. The latest run writes its result to `.e2e/report.json`.

To target an existing disposable instance, set `APP_URL` and `E2E_USER_OWNER_PASSWORD` for a disposable administrator named `e2e-owner`. Give the instance a writable mount named `e2e` containing the fixture. For the account and protected-share journeys, also configure fresh `E2E_MEMBER_PASSWORD`, `E2E_REPLACEMENT_PASSWORD`, and `E2E_SECRET_SHARE_PASSWORD` values. Run `bun run test:e2e`. The full suite creates accounts, changes settings, and moves files in that instance.

## Test the packaged server

`bun run test:e2e:packaged` builds the production server and browser assets into the fixture’s temporary directory. It starts the same `dist/app/server.js` entry used by Docker, with the precompiled UI and a disposable database. Put file paths or ordinary e2e flags after the command.

```sh
bun run test:e2e:packaged --no-cache
E2E_BROWSER=firefox bun run test:e2e:packaged --no-cache
```

To check a signed-out recipient’s interrupted transfer and native file save, run `bun run test:e2e:packaged tests/recipient-resume.e2e.ts`. This deterministic check compares the resumed bytes and downloaded file with the original SHA-256.

## Verify the browser’s Downloads manager

1. Upload a file of at least 5 MiB to a disposable instance and record its SHA-256. Create a public landing link with a download bandwidth limit of 256 KiB/s.
2. Open the link in a fresh, signed-out browser profile. Click **Download**, then open Chrome’s Download history or Firefox’s Downloads Library.
3. Use the browser’s **Pause** control after some bytes arrive. In a test proxy, close that transfer’s active connection while keeping the server available.
4. Use the browser’s **Resume** control. Observe its `Range` request and the server’s `206 Partial Content` response. The start of `Content-Range` should equal the browser’s requested offset.
5. Verify the completed filename, length, and SHA-256 against the original file.

The November 2026 cloud run used separate 5,242,977-byte files named `field-recording.bin`. Both browser managers saved the original bytes.

| Browser | Resume offset | Validated SHA-256 |
| --- | ---: | --- |
| Chrome for Testing 159.0.8154.6 | 884,736 | `a050ee6ebad82fa15777cb47123900106d58921c7d37b4a954a3968b4440a2c1` |
| Firefox 159.0 | 557,056 | `85dd231f6a6b0b6452b526371080f66fe0d8b113018cc7573c0fbdcd5968dfce` |
