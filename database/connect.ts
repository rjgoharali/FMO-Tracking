import pg from 'pg';
import { loadEnv } from '../backend/src/config.js';
import type { SqlClient } from './runner.js';

export async function connectDatabase() {
  loadEnv();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  await client.connect();
  const db: SqlClient = {
    query: async (sql, params) => client.query(sql, params),
    exec: async sql => client.query(sql),
  };
  return { db, close: () => client.end() };
}
