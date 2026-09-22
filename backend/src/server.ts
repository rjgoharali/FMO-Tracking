import pg from 'pg';
import { loadEnv, parseEnv } from './config.js';
import { buildApp } from './app.js';
import { postgresDatabase } from './db.js';
import { createStorage } from './storage.js';

loadEnv();
const env = parseEnv(process.env);
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
pool.on('error', () => console.error('Database pool connection failed'));
const app = await buildApp(env, async () => {
  const result = await pool.query("SELECT 1 FROM schema_migrations WHERE name = '002_backend_workflows.sql'");
  return result.rowCount === 1;
}, { db: postgresDatabase(pool), storage: createStorage(env) });
app.addHook('onClose', async () => { await pool.end(); });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void app.close(); });
await app.listen({ host: env.HOST, port: env.PORT });
