# Remix 3 Development Guide

## Architecture
- **Philosophy**: Web standards-first Bun, Use Web Streams API, Uint8Array, Web Crypto API, Blob/File instead of Node.js APIs

## Code Style
- **Imports**: Always use `import type { X }` for types (separate from value imports); use `export type { X }` for type exports; include `.ts` extensions
- **Classes**: Use native fields (omit `public`), `#private` for private members (no TypeScript accessibility modifiers)
- **Formatting**: Prettier (printWidth: 100, no semicolons, single quotes, spaces not tabs)
- **TypeScript**: Strict mode, ESNext target, ES2022 mod


## General
- we can't use typescripty `any` in any circumstances
- we style with tailwindcss
- we use eslint and prettier
- we use bun runtime
- every bit of ui must work flawlessly on desktop ipad and iphone
- we have JSX but we don't have react so never ever try to use react api
- we must always use BUN apis https://bun.com/docs.md


## Security

Perform a security review of this File Sharing repo (admin area; sharable upload/download flows for single and bulk files/folders). Base all findings strictly on code in this repo.

Constraints
- Bun + web standards (Web Streams, Uint8Array, Web Crypto, Blob/File). No Node-only APIs.
- TypeScript strict; no `any`; ESNext/ES2022 modules; TailwindCSS; JSX without React APIs.
- Use the import/export style defined above.

Output format
- Summary
- Vulnerabilities Found: severity, description, affected files/lines, evidence
- Recommendations: actionable fixes with Bun/TS-compatible snippets
- Overall Security Score (1–10) with rationale

What to do
1) Summarize: languages/deps; structure; routes/handlers; storage; tokens/links; entry points and data flows (HTTP params, headers, cookies, JSON, multipart, filenames, content types).
2) Scan (OWASP Top 10) + file-sharing specifics: path traversal/symlinks, Zip Slip, content-type sniffing, Content-Disposition/filename injection, dangerous extensions/Unicode, range requests, quotas/size/timeouts/rate limits/DoS, token entropy/expiry/scope/revocation, IDOR/cross-tenant leakage, CSRF on admin.
3) Dependencies: list third-party libs; simulate vulnerability check; propose safe versions/alternatives.
4) Code practices: secrets, validation/sanitization, crypto (AES-GCM with random IV; scrypt/Argon2/PBKDF2), auth/session/cookie flags, authorization on every endpoint and bulk ops, error handling (no info leaks), logging/audit (no secrets; security events).
5) Simulate static analysis (CodeQL/Semgrep-like) with rule-style findings and file:line evidence.
6) Fixes: precise Bun/Web API–compatible TypeScript changes (no Node APIs, no `any`): safe path resolution, allowlisted MIME/extension, RFC 5987 Content-Disposition, signed tokens with expiry/scope, CSRF defenses, size/time/rate limits, safe ZIP/TAR handling.
7) Iterate; mark uncertain items as “Needs verification.”

Evidence
- Cite exact file paths and line ranges using path-based code blocks:
  ```path/in/repo.ts#L12-28
  (snippet)
  ```
- Prioritize accuracy; cite OWASP/ASVS/SAFECode where relevant.
