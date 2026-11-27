# Operating the Cloudflare edition

The application origin is `https://dl.ldev.cloud`. The Worker serves the interface, verifies sessions and returns transfer instructions. A single SQLite-backed `CloudWorkspace` Durable Object serializes reservations, link state and capacity across users. Private R2 stores object bytes. The browser sends multipart PUT requests to the account’s R2 S3 endpoint. Authorized downloads redirect to that endpoint and support byte ranges. The Worker and Durable Object only handle bounded metadata. [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

The catalog accepts up to 100,000,000 bytes per file and 4,000,000,000 bytes of stored files and outstanding reservations combined. It queues a private alert at 3,600,000,000 bytes. Ready files expire 30 days after completion. Pending uploads expire after 24 hours. A five-minute cron trigger runs cleanup and retries alerts. Cleanup releases capacity after R2 confirms removal. R2 download grants last at most 15 minutes and are bounded by the underlying grant’s expiry. A withdrawal prevents new download grants. A previously issued URL can work until its expiry or object deletion. [Cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

## Local verification in Codex Cloud

Use Bun 1.4.5 and Node 24. The local fixture starts Wrangler’s workerd, SQLite Durable Objects, the Workers Email Service simulator, and an independent MinIO service. It stages the same five public assets used by the deployment, binds all listeners to loopback and discards its private mail, credentials and storage on exit. Its test entry implements the native R2 control operations against the same MinIO bucket that the browser reaches directly. The production entry uses Cloudflare’s native R2 binding. The tests obtain verification codes from the simulator’s local mail files. [Local Email Service development](https://developers.cloudflare.com/email-service/observability/local-development/sending/)

```sh
bun install --frozen-lockfile
bun run cloud:check
bun test tests/cloudflare
bun run cloud:e2e --smoke-only
bun run cloud:e2e
E2E_BROWSER=firefox bun run cloud:e2e
```

The standalone smoke also reserves the 4 GB limit, verifies the 3.6 GB capacity alert and confirms readmission after cancellation. It verifies a real sign-in, direct cross-origin writes for an empty object and an 8 MiB two-part object, ETag visibility, completion replay, byte-for-byte retrieval, a suffix range, deletion and a scheduled maintenance invocation. Browser tests exercise recipient and owner workflows. Install the browsers selected by the e2e web engine if the execution image does not include them. The local fixture downloads the pinned MinIO release on Linux x64 or arm64 and verifies its SHA-256. Set `LSHARE_MINIO_CACHE` to share the verified binary directory across isolated checkouts. Set `MINIO_BINARY` to use an existing MinIO executable. [MinIO release](https://github.com/minio/minio/releases/tag/RELEASE.2025-09-07T16-13-09Z)

## Production resources

1. Use an active Cloudflare zone that contains `dl.ldev.cloud`. Keep the hostname available for the `lshare` Worker Custom Domain. Wrangler provisions the DNS record and certificate when it deploys the Worker. The configuration disables workers.dev and preview URLs. [Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
2. Enable R2. Create a dedicated private bucket named `lshare-objects` in the account and jurisdiction for this deployment. Keep r2.dev and custom bucket domains disabled. Keep other applications, uploaders and replication jobs out of this bucket. On first installation the preflight lists objects and multipart uploads and requires both inventories to be empty. On updates it recognizes the existing `lshare` Worker using its catalog marker, SQLite class and R2 binding. Preserve the deployment name, Durable Object namespace, singleton name, bucket and migration history when updating. [Creating R2 buckets](https://developers.cloudflare.com/r2/buckets/create-buckets/) · [Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
3. Create an R2 S3 credential with Object Read & Write access scoped to that bucket. The service needs to list multipart uploads for recovery. Configure the application origin for GET, HEAD and PUT, allow the Content-Type and Range request headers, and expose ETag, Content-Length, Content-Range, Accept-Ranges and Content-Disposition. The prepare command installs this policy when none exists. It stops for conflicting existing policies. Lifecycle rules covering `files/` must allow at least one day for incomplete multipart uploads and at least 31 days for completed objects, including the reservation and retention windows. R2’s default seven-day abandoned multipart cleanup is compatible. [R2 credentials](https://developers.cloudflare.com/r2/api/tokens/) · [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/) · [Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
4. Enable Cloudflare Email Sending for the sender domain and verify the DNS records shown by Email Service. Use a Workers Paid plan for sending sign-in codes to arbitrary verified-by-code recipients. A free plan restricts recipients to verified destinations in the account. Privately configure the sender and capacity-alert addresses. The preflight checks sender onboarding and compares the required DNS records with the active zone. The production `EMAIL` binding uses the Email Service structured send API. [Sending email from Workers](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
5. Configure the Cloudflare deployment credentials with access to read the account, domain, DNS records and Email Sending settings, manage the private R2 bucket/CORS and publish the Worker, Durable Object migration, assets, cron and route. The S3 credential and deployment token have different scopes. Keep them in encrypted deployment secrets. [Wrangler authentication](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) · [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)

| Deployment setting | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Account owning the zone, Worker and bucket. The deployer sets `R2_ACCOUNT_ID` to this value. |
| `CLOUDFLARE_API_TOKEN` | Scoped Cloudflare management token. An interactive operator can instead use Wrangler OAuth. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Bucket-scoped S3 signing credentials, bound to the Worker as secrets. |
| `MAIL_FROM`, `ALERT_EMAIL` | Verified sender and private alert recipient, bound as Worker secrets. |
| `R2_JURISDICTION` | Optional. Use `eu` or `fedramp` only for a bucket in that jurisdiction. The deployer sets both the native binding and the signed endpoint accordingly. |

## Publish

For a shell-free deployment, open the repository’s **Settings → Environments**, create `cloudflare-production`, and enter the six required deployment secrets from the table. Open **Actions → Deploy lshare to Cloudflare → Run workflow** on the default branch. The manual workflow installs the locked toolchain, tests Cloudflare services, builds the production bundle, prepares storage and deploys. [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

For a new account without a bucket-scoped S3 credential, select **prepare** first. It creates the private bucket so you can scope the credential to it. Add the two R2 signing secrets to the environment, then select **deploy**. Select **check** to inspect an existing configuration without publishing a Worker version.

Operators using their own authenticated environment can run the same steps manually. `cloud:check` compiles locally. `cloud:deploy --check` verifies the live configuration without changing it. `--prepare` can create the named private bucket and apply the policy to a bucket with no existing CORS rules. `cloud:deploy` reruns the checks before passing secrets and configuration to Wrangler. For initial provisioning, `--prepare` also accepts both S3 credentials omitted when creating a new bucket. Generate the credential against that bucket and rerun `--check` before publishing. It writes the four secret values to a private temporary JSON file, passes its path to Wrangler, and removes it after the command completes.

```sh
bun run cloud:check
bun run cloud:deploy --prepare
bun run cloud:deploy --check
bun run cloud:deploy
```

After publishing, open the custom domain, verify an actual email delivery, upload a small disposable file and download it from a fresh browser session. Check that the file bytes travel to and from the account’s private S3 endpoint and remove the file. Check Workers scheduled events and email delivery logs for cleanup or alert retries. Treat signed URLs and challenge codes as bearer secrets when collecting diagnostics. A local smoke test verifies the protocol and application logic. DNS, certificate activation, real inbox delivery and production R2 require the target account. [Email Service observability](https://developers.cloudflare.com/email-service/observability/) · [Workers metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
