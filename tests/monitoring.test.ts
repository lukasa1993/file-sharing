import { expect, test } from 'bun:test'
import { Effect, Fiber, Layer, Metric } from 'effect'
import { TestClock } from 'effect/testing'
import { AppError } from '../app/contracts.ts'
import {
  counters,
  maintenanceLoop,
  retryDatabaseSetup,
} from '../app/monitoring.ts'

const testLayer = () =>
  Layer.merge(
    TestClock.layer(),
    Layer.succeed(Metric.MetricRegistry, new Map()),
  )

test('the application retries database contention on its bounded backoff schedule', async () => {
  const program = Effect.gen(function* () {
    let attempts = 0
    const busy = new AppError(503, 'busy', {
      cause: Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }),
    })
    const fiber = yield* Effect.forkChild(
      retryDatabaseSetup(
        Effect.suspend(() => {
          attempts++
          return attempts < 3 ? Effect.fail(busy) : Effect.succeed(42)
        }),
      ),
    )
    yield* TestClock.adjust('49 millis')
    expect(attempts).toBe(1)
    yield* TestClock.adjust('1 millis')
    expect(attempts).toBe(2)
    yield* TestClock.adjust('100 millis')
    expect(yield* Fiber.join(fiber)).toBe(42)
    expect((yield* counters).databaseRetries).toBe(2)
    const invalid = yield* Effect.result(
      retryDatabaseSetup(
        Effect.fail(new AppError(400, 'Invalid database settings')),
      ),
    )
    expect(invalid._tag).toBe('Failure')
    expect((yield* counters).databaseRetries).toBe(2)
  })
  await Effect.runPromise(Effect.provide(program, testLayer()))
})

test('maintenance resumes after a failed sweep and stops when the worker is interrupted', async () => {
  const program = Effect.gen(function* () {
    let invocations = 0
    const worker = yield* Effect.forkChild(
      maintenanceLoop(
        Effect.suspend(() => {
          invocations++
          return invocations === 1
            ? Effect.fail(new AppError(503, 'Unavailable'))
            : Effect.void
        }),
      ),
    )
    yield* TestClock.adjust('14 minutes')
    expect(invocations).toBe(0)
    yield* TestClock.adjust('1 minute')
    expect((yield* counters).maintenanceFailures).toBe(1)
    yield* TestClock.adjust('15 minutes')
    expect((yield* counters).maintenanceRuns).toBe(1)
    yield* Fiber.interrupt(worker)
    yield* TestClock.adjust('1 hour')
    expect(invocations).toBe(2)
    expect((yield* counters).maintenanceActive).toBe(0)
  })
  await Effect.runPromise(Effect.provide(program, testLayer()))
})
