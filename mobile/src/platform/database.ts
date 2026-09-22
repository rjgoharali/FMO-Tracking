import * as SQLite from 'expo-sqlite';
import type { Sql, SqlDatabase } from '../core/types';
import { Repository } from '../core/repository';
let pending: Promise<Repository> | null = null;
function adapter(db: SQLite.SQLiteDatabase): Sql {
  return { exec: sql => db.execAsync(sql), run: async (sql, ...params) => { await db.runAsync(sql, ...params); }, all: (sql, ...params) => db.getAllAsync(sql, ...params) };
}
export function repository() {
  if (!pending) pending = (async () => {
    const sqlite = await SQLite.openDatabaseAsync('fmo-duty-v1.db');
    await sqlite.execAsync('PRAGMA busy_timeout=10000;');
    const sql: SqlDatabase = { ...adapter(sqlite), transaction: async <T>(fn: (sql: Sql) => Promise<T>): Promise<T> => {
      let result!: T;
      await sqlite.withExclusiveTransactionAsync(async tx => { result = await fn(adapter(tx)); });
      return result;
    } };
    const repo = new Repository(sql); await repo.init(); return repo;
  })().catch(error => { pending = null; throw error; });
  return pending;
}
