import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

export interface SqlClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}
export const migrationsPath = new URL('./migrations/', import.meta.url);

export async function migrate(db: SqlClient, directory = migrationsPath) {
  await db.exec('BEGIN');
  try {
    // Serialize migration runners on one dedicated PostgreSQL connection.
    await db.query('SELECT pg_advisory_xact_lock(702641923)');
    await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const names = (await readdir(directory)).filter(n => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
    if (!names.length) throw new Error('No migrations found');
    const existing = await db.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
    for (const row of existing.rows) if (!names.includes(row.name)) throw new Error(`Applied migration is missing: ${row.name}`);
    const applied: string[] = [];
    for (const name of names) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = existing.rows.find(row => row.name === name);
      if (previous) {
        if (previous.checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await db.exec(sql);
      await db.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [name, checksum]);
      applied.push(name);
    }
    await db.exec('COMMIT');
    return applied;
  } catch (error) { await db.exec('ROLLBACK'); throw error; }
}
