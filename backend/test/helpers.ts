import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { migrate } from '../../database/runner.js';
import { postgresDatabase, type Database, type Db } from '../src/db.js';

export async function testDatabase(): Promise<{ db: Database; close: () => Promise<void> }> {
  if (process.env.TEST_DATABASE_URL) {
    const control = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await control.connect();
    const schema = `api_test_${randomUUID().replaceAll('-', '')}`;
    await control.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, options: `-c search_path=${schema}`, statement_timeout: 20000 });
    const client = await pool.connect();
    try { await migrate({ query: (sql, params) => client.query(sql, params), exec: sql => client.query(sql) }); }
    finally { client.release(); }
    return { db: postgresDatabase(pool), close: async () => { await pool.end(); await control.query(`DROP SCHEMA ${schema} CASCADE`); await control.end(); } };
  }
  const client = new PGlite(); await migrate(client);
  // A single embedded connection must serialize whole transactions, not statements.
  let tail = Promise.resolve();
  const locked = async <T>(fn: () => Promise<T>) => {
    const previous = tail; let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous; try { return await fn(); } finally { release(); }
  };
  const direct: Db = { query: (sql, params) => client.query(sql, params) };
  const db: Database = {
    query: (sql, params) => locked(() => client.query(sql, params)),
    transaction: fn => locked(async () => {
      await client.exec('BEGIN');
      try { const result = await fn(direct); await client.exec('COMMIT'); return result; }
      catch (error) { await client.exec('ROLLBACK'); throw error; }
    }),
  };
  return { db, close: () => client.close() };
}
