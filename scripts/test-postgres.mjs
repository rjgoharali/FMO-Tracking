// Optional real PostgreSQL test harness. Supply a trusted PostgreSQL bin directory;
// it does not install a service, touch a system database, or download executables.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

const bin = resolve(process.env.PG_TEST_BIN ?? '.test-tools/node_modules/@embedded-postgres/windows-x64/native/bin');
const executable = name => join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
const testRoot = resolve('.test-postgres');
const work = join(testRoot, `run-${randomUUID()}`);
const data = join(work, 'data');
await mkdir(work, { recursive: true });
const password = randomBytes(32).toString('base64url');
const passwordFile = join(work, 'password');
await writeFile(passwordFile, password, { mode: 0o600 });
async function run(command, args, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, env });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`Process exited with code ${code}`)));
  });
}
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolvePort(address.port)); });
});
let started = false;
try {
  await run(executable('initdb'), ['-D', data, '-U', 'fmo_test', '--auth=scram-sha-256', `--pwfile=${passwordFile}`, '--encoding=UTF8', '--locale=C']);
  started = true;
  await run(executable('pg_ctl'), ['-D', data, '-l', join(work, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', '-t', '30', 'start']);
  const env = { ...process.env, TEST_DATABASE_URL: `postgresql://fmo_test:${password}@127.0.0.1:${port}/postgres` };
  if (!process.env.npm_execpath) throw new Error('Run this harness through npm run test:postgres');
  await run(process.execPath, [process.env.npm_execpath, 'test'], env);
} finally {
  let stopped = !started;
  if (started) {
    try { await run(executable('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop']); stopped = true; }
    catch { console.error('Could not stop test PostgreSQL. Preserve data directory for recovery:', work); }
  }
  if (!started) {
    try { console.error(await readFile(join(work, 'postgres.log'), 'utf8')); } catch { /* Initialization failed before a log existed. */ }
  }
  // The directory is generated above and must remain a strict child of the test root.
  if (stopped && resolve(work).startsWith(testRoot + sep + 'run-')) await rm(work, { recursive: true, force: true });
}
