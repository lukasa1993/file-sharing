# File server implementation

Read the [product brief](PRODUCT.md) and [build specification](docs/FILE_SERVER_BUILD_SPEC.md) for the user workflows, HTTP contracts, and release checks. The [Effect architecture addendum](docs/EFFECT_SPEC.md) takes precedence wherever the two specifications differ. All three product iterations are part of this build.

The production process runs Bun, native Remix 3, SQLite, and Effect 4. Pin dependencies exactly. Remix owns HTTP, validation, sessions, and rendering. Effect owns application services, resource scopes, cancellation, and background work. File content lives in the configured storage roots.
