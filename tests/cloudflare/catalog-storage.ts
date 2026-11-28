import type { Database } from 'bun:sqlite'
import type { CatalogStorage } from '../../cloudflare/catalog.ts'

// Exercise real SQLite commit/rollback and affected rows using the methods of
// the Workers cursor that the catalog and sharing services consume.
export function catalogStorage(db: Database): CatalogStorage {
  return {
    transactionSync<T>(work: () => T) {
      return db.transaction(work)()
    },
    sql: {
      exec(query: string, ...args: (string | number | null)[]) {
        // Workers permits several schema statements in one exec call.
        let rows: unknown[] = []
        if (/^\s*CREATE TABLE\b/i.test(query)) db.exec(query)
        else rows = db.query(query).all(...args)
        return {
          toArray: () => rows,
          [Symbol.iterator]: () => rows[Symbol.iterator](),
          one: () => {
            if (rows.length !== 1) throw new Error('Expected one SQL row')
            return rows[0]
          },
        }
      },
    },
  } as unknown as CatalogStorage
}
