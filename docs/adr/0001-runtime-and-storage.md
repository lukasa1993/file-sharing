# Bun HTTP transport and storage identity

The supported deployment uses one Bun 1.4.5 process, Remix 3.3.0, Effect 4.1.7, local SQLite and operator-managed Linux storage roots.

## HTTP transport

Download recipients need an accurate Content-Length and a strong validator to resume a transfer. The preflight found that Bun.serve discarded the supplied Content-Length when the application returned a streaming body. The production listener uses Bun's node:http implementation with the official Remix Node fetch adapter. This preserves range framing, forwards disconnects and keeps the response attached to its authorized file handle until consumption or cancellation. The production container exposes one HTTP port. The external proxy terminates HTTPS, preserves the canonical host and disables buffering and compression for file transfers. [Transport](../../app/transport.ts) · [Wire tests](../../tests/transport-lifecycle.test.ts) · [TLS acceptance](../../scripts/container-https.ts)

## Filesystem identity and recovery

Each configured root has an operator-owned identity marker. File operations traverse pinned Linux directory handles and check the mount, type and identity of the observed entry. Host administrators and external writers belong to the trust boundary. They must preserve the marker and publish completed external replacements by rename. A changed identity normally invalidates an identity-bound share. A portable backup records file content and the original identity pins while the service is stopped. An operator restoring a physically copied tree must match that inventory before the restore can rebind valid pins. The normal online metadata backup remains available. [Resolver](../../app/filesystem/resolver.ts) · [Recovery test](../../tests/integration/recovery.test.ts) · [Operations](../operations.md)

## Format support

The owner selected streamed TAR and TAR.GZ. These exports preserve ordinary filenames and paths and restart from the beginning when interrupted. On Linux the application confines inline previews to validated supported representations. It offers original-file downloads for unsupported formats and uses a bounded, escaped renderer for text and Markdown. [Archive formats](../../app/archive-formats.ts) · [Media and archive journeys](../../tests/transfer-preview.e2e.ts)

The [implementation evidence](../implementation-status.md) records the versioned checks, observed results and outstanding release measurements.
