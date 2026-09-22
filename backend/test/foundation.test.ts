import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/config.js';
import { hashPassword, verifyPassword } from '../src/password.js';

const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', JWT_SECRET: 'a'.repeat(48) };
test('configuration rejects missing secrets, wildcard origins and insecure production CORS', () => {
  assert.throws(() => parseEnv({ ...base, JWT_SECRET: 'short' }));
  assert.throws(() => parseEnv({ ...base, JWT_SECRET: 'replace-with-at-least-32-random-characters' }));
  assert.throws(() => parseEnv({ ...base, CORS_ORIGINS: '*' }));
  assert.throws(() => parseEnv({ ...base, NODE_ENV: 'production' }));
  assert.equal(parseEnv(base).PORT, 4000);
});
test('health endpoints distinguish liveness and database/schema readiness', async () => {
  let ready = true;
  const app = await buildApp(parseEnv(base), async () => ready);
  try {
    assert.equal((await app.inject('/health/live')).statusCode, 200);
    assert.equal((await app.inject('/health/ready')).statusCode, 200);
    ready = false;
    assert.equal((await app.inject('/health/ready')).statusCode, 503);
    assert.equal((await app.inject('/api/duty/start')).statusCode, 404);
  } finally { await app.close(); }
});
test('readiness errors are sanitized and CORS only allows configured origins', async () => {
  const app = await buildApp(parseEnv(base), async () => { throw new Error('secret database credentials'); });
  try {
    const result = await app.inject('/health/ready');
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.includes('secret'), false);
    const allowed = await app.inject({ url: '/health/live', headers: { origin: 'http://localhost:3000' } });
    assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:3000');
    const denied = await app.inject({ url: '/health/live', headers: { origin: 'https://evil.example' } });
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
    assert.equal(allowed.headers['x-content-type-options'], 'nosniff');
  } finally { await app.close(); }
});
test('rate limiter returns 429 under repeated requests', async () => {
  const app = await buildApp(parseEnv(base), async () => true);
  try {
    for (let i = 0; i < 120; i++) assert.equal((await app.inject('/health/live')).statusCode, 200);
    assert.equal((await app.inject('/health/live')).statusCode, 429);
  } finally { await app.close(); }
});
test('password hashes are salted and verify without plaintext storage', async () => {
  const password = 'test-only-long-password';
  const a = await hashPassword(password); const b = await hashPassword(password);
  assert.notEqual(a, b); assert.equal(a.includes(password), false);
  assert.equal(await verifyPassword(password, a), true);
  assert.equal(await verifyPassword('incorrect', a), false);
  assert.equal(await verifyPassword(password, 'malformed'), false);
  await assert.rejects(hashPassword('short'));
});
