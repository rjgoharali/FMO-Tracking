// Persistent, loopback-only development setup. Never overwrites existing settings/data.
import { readFile, writeFile, mkdir, access, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import pg from 'pg';
import { parse } from 'dotenv';
const root = resolve('.');
const local = join(root, '.local-runtime'); await mkdir(local, { recursive: true });
const exists = path => access(path).then(() => true, () => false);
const bin = resolve(process.env.PG_TEST_BIN ?? '.test-tools/node_modules/@embedded-postgres/windows-x64/native/bin');
const exe = name => join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
async function run(command, args, env = process.env) {
  return new Promise((done, reject) => { const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, env }); child.on('error', reject); child.on('exit', code => code === 0 ? done() : reject(new Error('Setup command failed with exit ' + code))); });
}
const envPath = join(root, '.env');
if (!await exists(envPath)) {
  const password = randomBytes(32).toString('base64url');
  let text = await readFile(join(root, '.env.example'), 'utf8');
  const values = { POSTGRES_PASSWORD: password, DATABASE_URL: 'postgresql://fmo:' + password + '@127.0.0.1:5432/fmo_tracking', JWT_SECRET: randomBytes(48).toString('base64url') };
  for (const [key, value] of Object.entries(values)) text = text.replace(new RegExp('^' + key + '=.*$', 'm'), key + '=' + value);
  await writeFile(envPath, text, { flag: 'wx', mode: 0o600 });
}
const config = parse(await readFile(envPath)); const env = { ...process.env, ...config };
const configuredUrl = new URL(config.DATABASE_URL);
const controlUrl = config.DATABASE_URL.replace(/\/fmo_tracking$/, '/postgres');
async function canConnect(connectionString) { const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2000 }); try { await client.connect(); await client.query('SELECT 1'); return true; } catch { return false; } finally { await client.end().catch(() => undefined); } }
async function ensureDatabase() {
  const control = new pg.Client({ connectionString: controlUrl });
  await control.connect(); try { if (!(await control.query("SELECT 1 FROM pg_database WHERE datname='fmo_tracking'")).rowCount) await control.query('CREATE DATABASE fmo_tracking'); } finally { await control.end(); }
}
if (!await canConnect(config.DATABASE_URL)) {
  const url = configuredUrl;
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '5432' || url.username !== 'fmo' || url.pathname !== '/fmo_tracking') throw new Error('Configured database is unavailable. Existing non-default configuration was preserved.');
  if (await canConnect(controlUrl)) await ensureDatabase();
}
if (!await canConnect(config.DATABASE_URL)) {
  const url = configuredUrl;
  const data = join(local, 'postgres'); const passwordFile = join(local, 'postgres-password');
  if (!await exists(join(data, 'PG_VERSION'))) {
    await writeFile(passwordFile, decodeURIComponent(url.password), { mode: 0o600 });
    await run(exe('initdb'), ['-D', data, '-U', 'fmo', '--auth=scram-sha-256', '--pwfile=' + passwordFile, '--encoding=UTF8', '--locale=C']);
  }
  await run(exe('pg_ctl'), ['-D', data, '-l', join(local, 'postgres.log'), '-o', '-h 127.0.0.1 -p 5432', '-w', 'start']);
  await ensureDatabase();
}
await run(process.execPath, ['dist/database/migrate.js'], env);
const client = new pg.Client({ connectionString: config.DATABASE_URL }); await client.connect();
const hasAdmin = (await client.query("SELECT 1 FROM users WHERE role='SUPER_ADMIN' AND NOT is_demo")).rowCount;
const hasFmos = (await client.query('SELECT 1 FROM fmos LIMIT 1')).rowCount; await client.end();
if (!hasAdmin) {
  const file = join(local, 'admin-access.txt');
  const password = await exists(file) ? (await readFile(file, 'utf8')).match(/^Password: (.+)$/m)?.[1] : randomBytes(18).toString('base64url');
  if (!password) throw new Error('Existing local administrator credential file is unreadable; it was preserved.');
  if (!await exists(file)) await writeFile(file, 'Local dashboard: http://localhost:3000\nAdmin ID: LOCAL-ADMIN\nPassword: ' + password + '\nKeep this file private. This is local development, not a public deployment.\n', { flag: 'wx', mode: 0o600 });
  await run(process.execPath, ['dist/database/seed/admin.js'], { ...env, ADMIN_EMPLOYEE_CODE: 'LOCAL-ADMIN', ADMIN_NAME: 'Local Administrator', ADMIN_PASSWORD: password });
}
if (!hasFmos) {
  const path = join(local, 'demo-access.json');
  const credentials = await exists(path) ? JSON.parse(await readFile(path, 'utf8')) : { adminPassword: randomBytes(18).toString('base64url'), fmoPassword: randomBytes(18).toString('base64url') };
  if (!await exists(path)) await writeFile(path, JSON.stringify(credentials, null, 2), { flag: 'wx', mode: 0o600 });
  await run(process.execPath, ['dist/database/seed/run.js'], { ...env, NODE_ENV: 'development', ALLOW_DEMO_SEED: 'true', SEED_ADMIN_PASSWORD: credentials.adminPassword, SEED_FMO_PASSWORD: credentials.fmoPassword });
}
const mobileEnv = join(root, 'mobile', '.env'); if (!await exists(mobileEnv)) await writeFile(mobileEnv, await readFile(join(root, 'mobile', '.env.example')), { flag: 'wx', mode: 0o600 });
async function start(name, args, cwd, url) {
  try { if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return; } catch { /* Start our service below. */ }
  const log = await open(join(local, name + '.log'), 'a');
  const child = spawn(process.execPath, args, { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
  child.unref(); await writeFile(join(local, name + '.pid'), String(child.pid)); await log.close();
  for (let attempt = 0; attempt < 30; attempt++) { await new Promise(done => setTimeout(done, 1000)); try { if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return; } catch { /* Await startup. */ } }
  throw new Error(name + ' did not become healthy. Inspect its private local log.');
}
if (process.env.LOCAL_SETUP_NO_SERVICES !== 'true') {
  await start('backend', [join(root, 'dist/backend/src/server.js')], root, 'http://127.0.0.1:4000/health/ready');
  await start('dashboard', [join(root, 'node_modules/vite/bin/vite.js')], join(root, 'admin-dashboard'), 'http://localhost:3000');
  console.log('Local PostgreSQL, API and dashboard are running. Open http://localhost:3000. Credentials are in .local-runtime/admin-access.txt (not printed).');
} else console.log('Persistent local database and private credentials are configured. Service startup deferred until tests finish.');
