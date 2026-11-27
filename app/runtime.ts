import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  Clock,
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Metric,
  PubSub,
  Schedule,
} from 'effect'
import { createSqliteDatabase } from 'remix/data-table/sqlite'
import type { AppConfig } from './contracts.ts'
import { asAppError, attempt } from './effects.ts'
import { Filesystem, FileStorage } from './filesystem/index.ts'
import { Identity } from './identity/index.ts'
import { Metadata, initializeMetadata } from './metadata.ts'
import { Shares } from './shares/index.ts'
import { Transfers } from './transfers/index.ts'
import { counters, maintenanceLoop, retryDatabaseSetup } from './monitoring.ts'

export const Configuration = Context.Service<AppConfig>(
  'fileserver/Configuration',
)
export const ApplicationDatabase = Context.Service<Database>(
  'fileserver/ApplicationDatabase',
)
export const Accounts = Context.Service<Identity>('fileserver/Identity')
export const Storage = FileStorage
export const FileTransfers = Context.Service<Transfers>('fileserver/Transfers')
export const Sharing = Context.Service<Shares>('fileserver/Sharing')
type Active = ReturnType<Transfers['active']>
export const TransferEvents = Context.Service<PubSub.PubSub<Active>>(
  'fileserver/TransferEvents',
)
export const AppMetadata = Context.Service<Metadata>('fileserver/Metadata')

const databaseLayer = Layer.effect(
  ApplicationDatabase,
  Effect.gen(function* () {
    const config = yield* Configuration
    const db = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
          const filename = join(config.dataDir, 'fileserver.sqlite')
          const client = new Database(filename, { create: true, strict: true })
          try {
            chmodSync(filename, 0o600)
            client.exec(
              'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000',
            )
            return client
          } catch (error) {
            client.close()
            throw error
          }
        },
        catch: asAppError,
      }).pipe(retryDatabaseSetup),
      (client) => Effect.sync(() => client.close()),
    )
    const adapter = yield* Effect.acquireRelease(
      Effect.sync(() => createSqliteDatabase(db)),
      (a) => Effect.promise(() => a.close()),
    )
    yield* retryDatabaseSetup(attempt(() => initializeMetadata(adapter)))
    return db
  }),
)
const identityLayer = Layer.effect(
  Accounts,
  Effect.gen(function* () {
    const service = new Identity(
      yield* ApplicationDatabase,
      yield* Configuration,
      yield* Clock.Clock,
    )
    yield* attempt(() => service.init())
    return service
  }),
)
const storageLayer = Layer.effect(
  Storage,
  Effect.gen(function* () {
    const config = yield* Configuration
    return new Filesystem(
      config.mounts,
      yield* ApplicationDatabase,
      config.privateLocations,
    )
  }),
)
const metadataLayer = Layer.effect(
  AppMetadata,
  Effect.map(ApplicationDatabase, (db) => new Metadata(db)),
)
const transferLayer = Layer.effect(
  FileTransfers,
  Effect.gen(function* () {
    const db = yield* ApplicationDatabase,
      fs = yield* Storage,
      config = yield* Configuration,
      clock = yield* Clock.Clock
    const service = yield* Effect.acquireRelease(
      Effect.sync(() => new Transfers(db, fs, config.transferLimits, clock)),
      (t) => Effect.promise(() => t.shutdown()),
    )
    yield* attempt(() => service.cleanup())
    return service
  }),
)
const shareLayer = Layer.effect(
  Sharing,
  Effect.gen(function* () {
    return new Shares(
      yield* ApplicationDatabase,
      yield* Storage,
      yield* Accounts,
      yield* FileTransfers,
      yield* Clock.Clock,
    )
  }),
)
const eventsLayer = Layer.effect(
  TransferEvents,
  Effect.gen(function* () {
    const transfers = yield* FileTransfers
    const events = yield* Effect.acquireRelease(
      PubSub.sliding<Active>(1),
      PubSub.shutdown,
    )
    yield* Effect.forkScoped(
      Effect.repeat(
        Effect.suspend(() => PubSub.publish(events, transfers.active())),
        Schedule.spaced('2 seconds'),
      ),
    )
    return events
  }),
)
const maintenance = Layer.effectDiscard(
  Effect.gen(function* () {
    const meta = yield* AppMetadata
    const fs = yield* Storage
    const transfers = yield* FileTransfers
    const sweep = Effect.gen(function* () {
      yield* attempt(() => transfers.cleanup())
      yield* fs.collectTrashTask(
        Number(meta.value('trashRetentionDays', '30')) * 86400000,
      )
      meta.trimLog()
    })
    yield* Effect.forkScoped(maintenanceLoop(sweep))
  }),
)
export function createRuntime(config: AppConfig) {
  const base = databaseLayer.pipe(
    Layer.provideMerge(Layer.succeed(Configuration, config)),
  )
  const core = Layer.mergeAll(identityLayer, storageLayer, metadataLayer).pipe(
    Layer.provideMerge(base),
  )
  const transfers = transferLayer.pipe(Layer.provideMerge(core))
  const complete = Layer.mergeAll(shareLayer, eventsLayer, maintenance).pipe(
    Layer.provideMerge(transfers),
    Layer.provideMerge(Layer.succeed(Metric.MetricRegistry, new Map())),
  )
  return ManagedRuntime.make(complete)
}
export const applicationServices = Effect.gen(function* () {
  const registry = yield* Metric.MetricRegistry
  return {
    config: yield* Configuration,
    db: yield* ApplicationDatabase,
    identity: yield* Accounts,
    fs: yield* Storage,
    meta: yield* AppMetadata,
    shares: yield* Sharing,
    transfers: yield* FileTransfers,
    events: yield* TransferEvents,
    counters: () =>
      Effect.runSync(
        counters.pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      ),
  }
})
export type Services = Effect.Success<typeof applicationServices>
