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

You are analyzing a code repository for security vulnerabilities. Review the provided code from the repository: File Sharing, admin part, sharable upload flow and sharable download flow, single and bunlk files/folders

Follow these steps:
1. Summarize the repository: Identify the main languages, frameworks, dependencies, and overall structure. Highlight entry points like APIs, user inputs, or data flows.
2. Scan for vulnerabilities: Check against OWASP Top 10, including injection (SQL, command), broken authentication, sensitive data exposure, XML external entities, broken access control, security misconfigurations, cross-site scripting (XSS), insecure deserialization, using components with known vulnerabilities, and insufficient logging/monitoring.
3. Analyze dependencies: List third-party libraries and check for known vulnerabilities (simulate tools like OWASP Dependency-Check). Suggest updates or safer alternatives.
4. Review code practices: Look for issues like hard-coded secrets, improper error handling, lack of input validation/sanitization, unsafe crypto implementations, race conditions, or buffer overflows. Ensure least privilege, secure defaults, and proper encryption.
5. Simulate tools: Pretend to run static analysis like CodeQL, Bandit, or Semgrep. Flag any potential findings.
6. Suggest fixes: For each issue, provide specific, secure code improvements with explanations. Use secure libraries (e.g., bcrypt for hashing, parameterized queries).
7. Iterative review: Review your own analysis for missed problems, then improve it.

Output in this format:
- **Summary**: High-level overview.
- **Vulnerabilities Found**: Bullet list with severity (low/medium/high/critical), description, affected files/lines, and evidence.
- **Recommendations**: Actionable fixes with code snippets.
- **Overall Security Score**: 1-10 rating with justification.

Prioritize accuracy, cite standards like OWASP or SAFECode, and avoid hallucinations—base on provided code only.
