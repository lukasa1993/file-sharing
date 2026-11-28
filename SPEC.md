# lshare implementation

Read the [product brief](PRODUCT.md) and [build specification](docs/FILE_SERVER_BUILD_SPEC.md) for the user workflows, HTTP contracts, and release checks. The [Effect architecture addendum](docs/EFFECT_SPEC.md) takes precedence wherever the two specifications differ. All three product iterations are part of this build.

The self-hosted production process runs Bun, native Remix 3, SQLite, and Effect 4. Pin dependencies exactly. Remix owns HTTP, validation, sessions, and rendering. Effect owns application services, resource scopes, cancellation, and background work. File content lives in the configured storage roots.

The Cloudflare profile runs the same portable file-transfer contract on Workers with a SQLite Durable Object and private R2. Cloudflare handles identity verification and storage notifications through Email Service. The [profile contract](docs/transfer-api.md) defines its quotas, retention and signed upload/download behavior. The profiles share a package and select their runtime adapters at their own entry points.
