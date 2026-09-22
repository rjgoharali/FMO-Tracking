import type pg from 'pg';
import type { SqlClient } from '../../database/runner.js';

export type Db = Pick<SqlClient, 'query'>;
export interface Database extends Db { transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> }
export function postgresDatabase(pool: pg.Pool): Database {
  return {
    query: (sql, params) => pool.query(sql, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
  };
}
export async function one<T extends Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []) {
  return (await db.query<T>(sql, params)).rows[0];
}
export async function serverTime(db: Db) {
  const row = await one<{ time: Date }>(db, "SELECT date_trunc('milliseconds', clock_timestamp()) AS time");
  return new Date(row!.time);
}
export async function audit(db: Db, actorId: string, action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}) {
  await db.query('INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata) VALUES ($1,$2,$3,$4,$5)', [actorId, action, entityType, entityId, JSON.stringify(metadata)]);
}
