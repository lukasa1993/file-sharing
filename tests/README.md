# Browser tests in Codex Cloud

From this repository, ask Codex to run the browser tests. The fixture command starts the real server on a free loopback port and creates a temporary storage mount, SQLite database, owner account and file. It removes them when the tests finish.

```sh
bun run test:e2e:fixture --no-cache
```

The Chromium journeys cover file and folder management, shares and upload requests, transfer recovery, previews and archives, accounts, administration, display preferences, and keyboard and mobile interactions. The owner setup authenticates once per run. Each test receives its own browser context; the server uses temporary files, generated credentials, and a fresh SQLite database. The live ChatGPT handoff checks the copied share URL, the recipient’s download filename, and the exact bytes of [handoff.txt](fixtures/handoff.txt).

Run the deterministic journeys with `bun run test:e2e:fixture --exclude-tag agent`. Run just one flow by passing its test file to the same command. For Firefox, install the matching binary with `bun run e2e-web install firefox --with-deps` and set `E2E_BROWSER=firefox` when launching the fixture.

Agent steps use a ChatGPT subscription and default to `gpt-6-luna`. Set `E2E_CHATGPT_MODEL` to select another model available to the subscription. On a fresh workspace, Codex runs the setup commands and starts device sign-in. The account owner opens the displayed verification link and approves the code on their own device. The credential stays outside the repository.

```sh
bun install --frozen-lockfile
bun run e2e-web install chromium --with-deps
NODE_USE_ENV_PROXY=1 npx e2e login openai --device
```

The runner uses Node 24.8 or later and Bun 1.4.5. In a cloud image with npm and no Bun on the path, run the fixture with `npx --yes --package=bun@1.4.5 -- bun run test:e2e:fixture --no-cache`. The latest run writes its result to `.e2e/report.json`.

To target an existing disposable instance, set `APP_URL` and `E2E_USER_OWNER_PASSWORD` for a disposable administrator named `e2e-owner`. Give the instance a writable mount named `e2e` containing the fixture. For the account and protected-share journeys, also configure fresh `E2E_MEMBER_PASSWORD`, `E2E_REPLACEMENT_PASSWORD`, and `E2E_SECRET_SHARE_PASSWORD` values. Run `bun run test:e2e`. The full suite creates accounts, changes settings, and moves files in that instance.
