import { Cause, Effect, Metric, Schedule } from 'effect'
import type { AppError } from './contracts.ts'

// The managed runtime installs a fresh registry per application instance.
const responseDuration = Metric.histogram('http_response_preparation_ms', {
  boundaries: [1, 5, 25, 100, 500, 1000, 10000, 60000],
})
const serverErrors = Metric.counter('http_server_errors')
const maintenanceRuns = Metric.counter('maintenance_runs')
const maintenanceFailures = Metric.counter('maintenance_failures')
const maintenanceRunning = Metric.gauge('maintenance_active')
const databaseRetries = Metric.counter('database_startup_retries')

export function recordResponse(status: number, durationMs: number) {
  const timing = Metric.update(responseDuration, durationMs)
  return status >= 500
    ? timing.pipe(Effect.andThen(Metric.update(serverErrors, 1)))
    : timing
}

export const counters = Effect.all({
  requests: Metric.value(responseDuration).pipe(Effect.map((s) => s.count)),
  meanResponsePreparationMs: Metric.value(responseDuration).pipe(
    Effect.map((s) => (s.count ? s.sum / s.count : 0)),
  ),
  serverErrors: Metric.value(serverErrors).pipe(Effect.map((s) => s.count)),
  maintenanceRuns: Metric.value(maintenanceRuns).pipe(
    Effect.map((s) => s.count),
  ),
  maintenanceFailures: Metric.value(maintenanceFailures).pipe(
    Effect.map((s) => s.count),
  ),
  maintenanceActive: Metric.value(maintenanceRunning).pipe(
    Effect.map((s) => s.value),
  ),
  databaseRetries: Metric.value(databaseRetries).pipe(
    Effect.map((s) => s.count),
  ),
})

/** Retry only idempotent database setup, and only SQLite's contention errors. */
export function retryDatabaseSetup<A>(operation: Effect.Effect<A, AppError>) {
  return Effect.suspend(() => {
    let started = false
    const attempt = Effect.suspend(() => {
      if (started)
        return Metric.update(databaseRetries, 1).pipe(Effect.andThen(operation))
      started = true
      return operation
    })
    return Effect.retry(attempt, {
      times: 2,
      schedule: Schedule.exponential('50 millis'),
      while: (failure) => {
        const cause = failure.cause
        return (
          cause instanceof Error &&
          'code' in cause &&
          (cause.code === 'SQLITE_BUSY' || cause.code === 'SQLITE_LOCKED')
        )
      },
    })
  })
}

export function maintenanceLoop(sweep: Effect.Effect<void, AppError>) {
  const run = sweep.pipe(
    Effect.andThen(Metric.update(maintenanceRuns, 1)),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Metric.update(maintenanceFailures, 1).pipe(
            Effect.andThen(
              Effect.logWarning('Storage maintenance did not complete'),
            ),
          ),
    ),
  )
  return Effect.forever(
    Effect.sleep('15 minutes').pipe(
      Effect.andThen(
        Effect.acquireUseRelease(
          Metric.update(maintenanceRunning, 1),
          () => run,
          () => Metric.update(maintenanceRunning, 0),
        ),
      ),
    ),
  )
}
