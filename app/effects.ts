import { Cause, Effect, Exit } from 'effect'
import { AppError } from './contracts.ts'
export { AppError } from './contracts.ts'

/** Preserve domain failures across the framework boundary. Unexpected details stay server-side. */
export function asAppError(cause: unknown): AppError {
  if (cause instanceof AppError) return cause
  return new AppError(500, 'The operation could not be completed', { cause })
}
export function attempt<A>(
  thunk: (signal: AbortSignal) => PromiseLike<A>,
  mapError = asAppError,
) {
  return Effect.tryPromise({ try: thunk, catch: mapError })
}
export async function runTask<A, E>(
  task: Effect.Effect<A, E>,
  options?: { signal?: AbortSignal },
) {
  const exit = await Effect.runPromiseExit(task, options)
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
  return exit.value
}
