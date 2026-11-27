# Product

<!-- impeccable:product-schema 1 -->

## Product Purpose

A self-hosted file-sharing service for friends. Someone with a file on their server can select it, copy a link into a conversation, and let a friend download it under its original name. The companion workflow runs in the other direction. An owner chooses a folder and sends a request so a friend can deliver files there without seeing its contents.

## Platform

web

## Users

- **Host administrator.** Connects existing storage, provisions local accounts, grants access to folders, and investigates unavailable storage, failed transfers, or broken links.
- **Invited user.** Organizes files in a private home or shared directory. With permission, they can send a file or open a folder to a friend and later change or revoke access.
- **Link recipient.** Opens a shared URL on a phone or computer to download a file, browse the shared folder, or fulfill an upload request. Public links work without an account. The owner can require a password or an authenticated account.

## Operating Context

The host's filesystem is the source of truth. An administrator can mount an existing directory, including a read-only one, and browse it immediately. Changes made by trusted tools appear on the next listing. A completed upload becomes an ordinary file at the chosen path, with its original name and folder structure. SQLite holds accounts, grants, shares, and transfer state.

A share points to an existing file or directory. For example, a friend opening `/rd` can receive `RemoteDesktop.exe` directly through the browser's download manager. An owner can choose a landing page when it helps the recipient check the filename and size first. A folder link lets the recipient browse only the shared subtree. The public entry point keeps private files and shares out of view.

## Capabilities and Constraints

All three iterations in the build specification are in scope for this build. P0, P1, and P2 put dependent work in order. Format support and deployment claims require verification on the supported stack.

| Workflow | What people need to accomplish |
| --- | --- |
| Manage files | Browse named roots in list or grid view. Find files across authorized folders, keep a selection while navigating, and rename, copy, move, or delete entries in bulk. Restore trashed items to their original paths with an explicit decision on conflicts. |
| Send files | Share one file, a folder, or selected items with a single link. Choose a random token or short alias, access rules, expiry, and optional transfer limits. Copy, edit, or revoke the link. Recipients can download individual items or a streamed archive. Public aliases require explicit confirmation. |
| Request uploads | Choose a destination folder, optionally set an expiry and total-size cap, and send one upload-only link. A friend can contribute files without an account or access to existing contents. A filename collision must preserve existing files and keep their names private. |
| Transfer files | Upload files or folder trees, see per-file progress, pause, retry, and resume. Keep partial files private. Administrators can inspect active transfers, set limits, and cancel work. |
| Open files | Preview supported images and media, read and edit text, and inspect archives within resource limits. Offer an ordinary download for unsupported formats. Advanced previews and ZIP/ZIP64 depend on the format and safety checks in the spec. |
| Manage access | Administer users, groups, folder grants, quotas, and scoped API tokens. Users can inspect and revoke sessions. Local login remains available independently of optional OIDC integration. |

Large transfers are a core use case. The release target includes files over 100 GB with bounded memory use. Downloads may resume while the representation is unchanged. Uploads must recover their confirmed progress after interruption or restart. The transfer UI distinguishes completion, interruption, and failure.

## Stack

One integrated Remix 3 application using TypeScript/TSX and native CSS, with one Bun process, one Linux container, and one HTTP port. The official Remix ecosystem supplies the web framework. Effect 4 supplies server-side service composition, resource lifetimes, and typed failures. Bun supplies SQLite and runtime services. Administrators provision local username/password accounts and groups. Permission checks apply to files, previews, transfers, and shares, including after the owner's access changes.

## Accessibility & Inclusion

Support desktop and mobile browsers, keyboard and touch, visible focus, accessible contrast, and reduced motion. Give drag-and-drop and context-menu actions visible alternatives, including a file picker and a selection menu. Distinguish an empty folder from an unavailable drive so users know whether to add a file or contact the host.

## Product Principles

- Let the recipient finish the handoff from the link. Show the filename, size, and next action when a page is needed.
- Make the scope of access clear before someone copies a link. Revocation, expiry, and permission changes must govern subsequent requests.
- Keep the owner's files usable through ordinary filesystem tools. Surface a missing or replaced share target so the owner can decide what recipients should receive.

## Evidence and Open Decisions

The pre-reset app demonstrated selection across folders, individual and bundled downloads, folder-targeted upload requests, and revocable links. The new build spec governs architecture, release scope, and acceptance tests. Production readiness depends on passing its storage, permission, transfer, and recovery gates. [Pre-reset product](https://github.com/lukasa1993/file-sharing/tree/f676043) · [Build specification](docs/FILE_SERVER_BUILD_SPEC.md)

`fileserver` is a working name. Final branding, default limits and retention, and support for untrusted external filesystem writers remain open.
