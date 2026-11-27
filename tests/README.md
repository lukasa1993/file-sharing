# Browser tests in Codex Cloud

From this repository, ask Codex to run the browser tests. The fixture command starts the real server on a free loopback port and creates a temporary storage mount, SQLite database, owner account and file. It removes them when the tests finish.

```sh
bun run test:e2e:fixture --no-cache
```

The first test opens the sign-in page as a visitor. The second signs in, creates a public landing-page share, copies its URL, clears the owner's session, and downloads the file. It verifies the URL, original filename and exact bytes. The fixture is [handoff.txt](fixtures/handoff.txt).

Agent steps use a ChatGPT subscription and default to `gpt-6-luna`. Set `E2E_CHATGPT_MODEL` to select another model available to the subscription. On a fresh workspace, Codex runs the setup commands and starts device sign-in. The account owner opens the displayed verification link and approves the code on their own device. The credential stays outside the repository.

```sh
bun install --frozen-lockfile
bun run e2e-web install chromium --with-deps
NODE_USE_ENV_PROXY=1 npx e2e login openai --device
```

The runner uses Node 24.8 or later and Bun 1.4.5. In a cloud image with npm and no Bun on the path, run the fixture with `npx --yes --package=bun@1.4.5 -- bun run test:e2e:fixture --no-cache`. The latest run writes its result to `.e2e/report.json`.

To target an existing disposable instance, set `APP_URL` and `E2E_USER_OWNER_PASSWORD` for the `e2e-owner` account and run `bun run test:e2e`. That instance must have the fixture in a mount named `e2e`. The owner needs permission to share it.
