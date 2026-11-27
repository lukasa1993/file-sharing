import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import {
  ActivityRegistry,
  defaultTransferLimits,
} from '../app/transfers/streams.ts'

test('one share schedules concurrent streams, later ranges and cancellations against a single byte budget', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make()
        const jobs = new ActivityRegistry(defaultTransferLimits, clock)
        const req = new Request('http://localhost/download')
        const first = jobs.start('download', 'shared', 8192, req, 8192)
        const second = jobs.start('archive', 'shared', null, req, 8192)
        const independent = jobs.start('download', 'other', 8192, req, 8192)
        yield* Effect.promise(() => first.meter(1024))
        yield* Effect.promise(() => independent.meter(1024))
        const secondChunk = second.meter(1024)
        yield* clock.adjust(124)
        expect(second.bytes).toBe(0)
        yield* clock.adjust(1)
        yield* Effect.promise(() => secondChunk)
        expect(second.bytes).toBe(1024)

        const blocked = first.meter(1024).then(
          () => false,
          () => true,
        )
        jobs.cancel(first.id)
        expect(yield* Effect.promise(() => blocked)).toBe(true)
        first.remove()
        second.remove()
        independent.remove()
        const retry = jobs.start('download', 'shared', 1024, req, 8192)
        const next = retry.meter(1024)
        yield* clock.adjust(124)
        expect(retry.bytes).toBe(0)
        yield* clock.adjust(1)
        yield* Effect.promise(() => next)
        expect(retry.bytes).toBe(1024)
        retry.remove()
        yield* Effect.promise(() => jobs.shutdown())
      }),
    ),
  )
})
