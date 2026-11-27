# Architecture Addendum — Effect TypeScript, Testing and Code Quality

Extend the existing FILE_SERVER_BUILD_SPEC.md with the following mandatory architectural and engineering requirements. These requirements supersede conflicting decisions in the original specification.

## 1. Effect TypeScript Integration

Adopt Effect TypeScript 4.x as the single permitted third-party production dependency outside the official Remix ecosystem.

Use the latest verified stable version compatible with our pinned Bun and Remix versions. Pin exact dependency versions and commit the lockfile.

Remix 3 remains responsible for HTTP routing, middleware, authentication, sessions, validation, rendering and UI components. Effect is responsible for server-side business logic, service composition, structured concurrency, resource management and typed error handling.

Do not introduce Effect's HTTP framework, database adapters, schema validation or other functionality that unnecessarily duplicates existing official Remix APIs.

Maintain a single integrated full-stack application, process, container and HTTP port.

## 2. Effect-First Business Logic

Use Effect consistently for:
- Filesystem services.
- File and directory operations.
- Permission evaluation.
- Share management.
- Upload lifecycle management.
- Download lifecycle management.
- Database operations.
- Background jobs.
- Transfer monitoring.
- Rate limiting.
- Configuration validation.
- Audit logging.
- Resource acquisition and release.
- Retry policies.
- Application startup and shutdown.

Use Effect services and Layers for dependency injection and service composition.

Define explicit, typed service contracts before parallel implementation begins.

Use tagged errors and discriminated unions for expected failures. Do not rely on untyped exceptions for normal application control flow.

Keep pure, synchronous utility functions simple. Do not wrap trivial operations in Effect without a meaningful reason.

Convert between Effect and native Promises at appropriate framework boundaries rather than throughout the application.

## 3. Resource Scoping and Lifecycle

Use Effect's native resource management and structured concurrency capabilities.

- Use scoped resources for file descriptors, streams, database connections, subscriptions, temporary files and transfer sessions.
- Use acquire/release patterns for resources requiring cleanup.
- Guarantee resource cleanup on success, failure, cancellation and interruption.
- Use application-scoped Layers and a managed runtime for long-lived services.
- Use operation-scoped resources for individual requests and transfers.
- Never close a download resource merely because a controller has returned its HTTP Response. Keep resources alive until the response stream completes, fails or is cancelled.
- Propagate client disconnections to the underlying operation where appropriate.
- Ensure interrupted uploads preserve valid resumable state.
- Prevent orphaned file handles, timers, subscriptions and background fibers.
- Do not launch unmanaged fire-and-forget asynchronous operations.
- Implement graceful shutdown with controlled interruption and cleanup.
- Explicitly distinguish interruptible operations from critical atomic filesystem operations.

Use native Bun and Remix file-streaming APIs where they provide better performance. Do not introduce unnecessary buffering or replace efficient native streaming without justification.

Effect does not replace operating-system filesystem confinement. Preserve all existing filesystem security requirements.

## 4. Structured Concurrency

Use Effect's concurrency primitives where appropriate:
- Fibers for managed concurrent operations.
- Semaphores for transfer and worker concurrency limits.
- Queues for background processing.
- PubSub for transfer events.
- Schedules for bounded retries and backoff.
- Rate limiters for controlled request and transfer rates.
- References or synchronized state for concurrent mutable state.

All queues must have explicit capacity and backpressure policies.

All retry policies must be bounded and limited to appropriate transient failures.

Do not retry permission failures, invalid inputs or non-idempotent operations blindly.

Prevent races involving concurrent uploads, quota enforcement, share revocation, file replacement and directory operations.

## 5. TypeScript Code Quality

Enable strict TypeScript compiler settings, including:
- strict
- noUncheckedIndexedAccess
- exactOptionalPropertyTypes
- noImplicitReturns
- noFallthroughCasesInSwitch
- noUnusedLocals
- noUnusedParameters
- useUnknownInCatchVariables

Enforce the following rules:
- No explicit any without documented justification.
- No unsafe type assertions used to bypass correctness.
- No non-null assertions without a demonstrated invariant.
- No @ts-ignore or @ts-nocheck.
- No unchecked external input.
- No empty catch blocks.
- No swallowed errors.
- No floating Promises or accidentally unexecuted Effects.
- No circular dependencies.
- No undocumented global mutable state.
- No duplicate implementations of shared functionality.
- No dead code, placeholder implementations or unfinished production paths.
- No disabling diagnostics merely to make CI pass.

Prefer explicit domain types, exhaustive pattern matching, discriminated unions, immutable data and small composable functions.

Use Remix Data Schema for validation at application boundaries.

## 6. Effect-Specific Static Analysis

Integrate the official Effect language service and compatible TypeScript tooling.

Enable Effect-specific diagnostics for:
- Missing service dependencies.
- Incorrect Layer composition.
- Unexecuted Effects.
- Incorrect Effect usage.
- Resource scope violations.
- Unsafe error handling.
- Incompatible package versions.
- Redundant operations.
- Nondeterministic operations that undermine testability.

Use the exact diagnostic names and configuration supported by the installed Effect version.

Treat correctness-related diagnostics as CI errors.

Verify editor diagnostics and command-line CI diagnostics independently.

Do not assume that ordinary TypeScript type checking automatically executes Effect language-service diagnostics.

## 7. Testing Architecture

Use Bun's native test runner and official Remix testing utilities.

Use Effect's native testing capabilities wherever applicable.

Implement:
- Unit tests.
- Service contract tests.
- Integration tests.
- HTTP endpoint tests.
- Real filesystem tests.
- Database migration tests.
- Authorization tests.
- Security regression tests.
- Resource lifecycle tests.
- Concurrency tests.
- Cancellation tests.
- Fault-injection tests.
- Property-based tests where supported by verified stable APIs.
- End-to-end application workflow tests.
- Performance and memory regression tests.

Use test Layers to replace dependencies cleanly.

Use Effect TestClock for deterministic testing of:
- Session expiration.
- Share expiration.
- Rate limiting.
- Retry delays.
- Background job scheduling.
- Abandoned upload cleanup.
- Time-dependent permissions.

Avoid real sleeps in unit tests.

Tests must be isolated, repeatable, independent of execution order and safe to run concurrently.

Do not replace critical filesystem and HTTP integration tests with mocked implementations.

## 8. Mutation Testing

Integrate StrykerJS as a development-only dependency.

Verify compatibility with Bun, TypeScript, Effect and the selected test runner before enabling mandatory mutation gates.

Use the command runner or another verified compatible integration if a dedicated Bun integration is unavailable.

Mutation testing must prioritize:
- Authentication.
- Authorization and permission inheritance.
- Filesystem confinement.
- Directory traversal prevention.
- Share expiration.
- Share revocation.
- Upload offset validation.
- Download range handling.
- Storage quota enforcement.
- Filename collision handling.
- Session management.
- Rate limiting.
- Resource cleanup.
- Atomic file replacement.

Configure incremental mutation testing where supported.

Run changed-module mutation tests during normal development and broader mutation suites during scheduled or release validation.

Review surviving mutants individually in security-critical modules.

Do not artificially improve mutation scores by excluding difficult code, weakening assertions or indiscriminately disabling mutation operators.

Document equivalent mutants and justified exclusions.

## 9. Coverage and Quality Gates

Establish the following minimum quality targets:
- TypeScript errors: 0.
- Lint errors: 0.
- Effect correctness diagnostics: 0.
- Formatting violations: 0.
- Failed tests: 0.
- Overall line coverage: at least 90%.
- Overall branch coverage: at least 85%.
- Security-critical executable code coverage: target 100%.
- Overall mutation score: at least 85%.
- Security-critical mutation score: target 100%, with reviewed equivalent mutants.
- Circular dependencies: 0.
- Known resource leaks: 0.
- Unmanaged background fibers: 0.
- Unapproved production dependencies: 0.
- Unresolved exploitable critical or high-severity vulnerabilities: 0.

Coverage and mutation metrics do not establish correctness or security by themselves.

Require explicit adversarial tests for security boundaries regardless of reported coverage.

Report unavailable measurements honestly. Do not claim that a quality gate has passed if its tooling could not execute.

## 10. Security and Failure Testing

Explicitly test:
- Unauthorized access attempts.
- Permission changes during active operations.
- Symbolic link attacks.
- Filesystem race conditions.
- Encoded and double-encoded directory traversal.
- Malicious filenames and HTTP headers.
- Concurrent file modifications.
- Invalid HTTP Range requests.
- Interrupted downloads.
- Interrupted and resumed uploads.
- Duplicate upload chunks.
- Concurrent requests against the same upload session.
- Disk exhaustion.
- Unavailable storage mounts.
- Database lock contention.
- Unexpected process termination.
- Restart recovery.
- Expired and revoked sessions.
- Expired and revoked sharing links.
- Malicious archive contents.
- Resource exhaustion attacks.
- Slow and disconnected clients.

Use fault injection to verify cleanup and recovery behavior.

Filesystem confinement and race resistance remain mandatory release gates. Do not assume Effect, Remix or Bun automatically solves these problems.

## 11. Observability

Use Effect's logging, tracing and metric capabilities where appropriate.

Implement:
- Structured application logs.
- Request correlation IDs.
- Transfer correlation IDs.
- Operation durations.
- Typed error categories.
- Active transfer metrics.
- Background queue metrics.
- Resource utilization metrics.
- Retry and failure counts.
- Security audit events.
- Graceful shutdown diagnostics.

Never log passwords, session tokens, share passwords or other credentials.

Keep observability local by default. Do not require external telemetry platforms or additional infrastructure.

## 12. Automated Development Commands

Provide consistent project scripts for:
- Development.
- Production startup.
- Build.
- Type checking.
- Effect diagnostics.
- Linting.
- Formatting.
- Formatting validation.
- Unit testing.
- Integration testing.
- Security testing.
- Coverage reporting.
- Mutation testing.
- Performance testing.
- Dependency auditing.
- Complete quality validation.

Prefer native Bun tooling and official Remix tooling.

Verify every command against the installed runtime and package versions.

Do not invent CLI commands or assume that proposed Bun capabilities exist without checking.

Provide a single quality-check command that executes the mandatory development validation gates.

Provide a separate comprehensive release-validation command for expensive security, mutation, concurrency and performance suites.

## 13. Parallel Codex Development

Before launching implementation agents:
- Update SPEC.md and AGENTS.md with these requirements.
- Verify actual Remix, Bun and Effect APIs.
- Pin compatible package versions.
- Establish the shared Effect service architecture.
- Define service contracts and tagged error conventions.
- Define Layer composition and application runtime ownership.
- Establish shared testing utilities.
- Configure TypeScript and Effect diagnostics.
- Verify mutation testing compatibility.
- Create a working reference implementation of one scoped filesystem service.
- Create a working reference implementation of one authenticated streaming HTTP endpoint.

Then parallelize implementation using isolated Git worktrees.

Each agent must:
- Own clearly defined modules.
- Implement against established service contracts.
- Provide tests alongside implementation.
- Use the existing shared Effect runtime.
- Avoid independently creating competing abstractions.
- Avoid modifying shared contracts without coordination.
- Run applicable quality gates before handing off work.
- Document implementation decisions and remaining limitations.
- Report actual test results.

Assign dedicated workstreams for:
- Effect foundation and runtime.
- Static analysis and tooling.
- Test infrastructure.
- Mutation testing.
- Resource lifecycle and concurrency verification.
- Filesystem security verification.
- Final integration and quality review.

Do not allow implementation agents to silently weaken shared quality requirements.

## 14. Dependency Policy

Production dependencies:
- Official Remix ecosystem packages.
- Effect TypeScript core.
- Bun native APIs.
- Standard Web and operating-system APIs.

Development-only dependencies:
- Official Effect language-service tooling.
- Compatible TypeScript tooling and type declarations.
- StrykerJS and its required development integrations.
- Other tooling only when explicitly justified and approved.

Do not introduce:
- Alternative HTTP frameworks.
- Alternative authentication frameworks.
- Alternative ORMs.
- Alternative schema-validation libraries.
- Separate frontend frameworks.
- Redis or external database servers.
- Unnecessary runtime utility packages.

Audit both direct and transitive dependencies. Keep development dependencies out of the production container wherever possible.

## 15. Implementation Philosophy

Remix-first.
Bun-native second.
Effect for business logic, resource safety and concurrency.
Custom extensions where necessary.
External dependencies only when explicitly justified.

Prioritize correctness, security, maintainability, predictable resource usage and a polished user experience over implementation speed.

Do not overengineer simple functionality.

Do not introduce abstractions solely for architectural purity.

Do not consider a feature complete merely because its happy path works.

Verify the actual APIs, execute the tests, enforce the quality gates and document the results before declaring implementation complete.
