// Isolated test-only server; never imported by the production entry point.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { testDatabase } from '../backend/test/helpers.js';
import { buildApp } from '../backend/src/app.js';
import { parseEnv } from '../backend/src/config.js';
import { LocalStorage } from '../backend/src/storage.js';
import { seedDemo } from '../database/seed/demo.js';

if (process.env.NODE_ENV !== 'test') throw new Error('Browser fixture server requires NODE_ENV=test');
const directory = await mkdtemp(join(tmpdir(), 'fmo-browser-fixture-'));
const { db, close } = await testDatabase();
await seedDemo({ query: (sql, params) => db.query(sql, params), exec: sql => db.query(sql) }, { adminPassword: 'browser-test-admin-password', fmoPassword: 'browser-test-fmo-password', storagePath: directory });
const env = parseEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused:unused@localhost/unused', JWT_SECRET: 'browser-test-only-secret-'.repeat(3), CORS_ORIGINS: 'http://localhost:3000' });
const app = await buildApp(env, async () => true, { db, storage: new LocalStorage(directory) });
app.addHook('onClose', async () => { await close(); if (resolve(directory).startsWith(resolve(tmpdir()) + sep + 'fmo-browser-fixture-')) await rm(directory, { recursive: true, force: true }); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
await app.listen({ host: '127.0.0.1', port: 4100 });
