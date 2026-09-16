import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate, schema } from './schema'

export type AppDatabase = BetterSQLite3Database<typeof schema>

export interface DatabaseClient {
  db: AppDatabase
  close(): void
}

export interface DatabaseOptions {
  filePath: string
}

export function createDatabase({ filePath }: DatabaseOptions): DatabaseClient {
  const sqlite = new Database(filePath)
  migrate(sqlite)

  return {
    db: drizzle(sqlite, { schema }),
    close: () => sqlite.close(),
  }
}
