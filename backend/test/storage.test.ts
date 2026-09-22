import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { LocalStorage, S3Storage, sanitizeSelfie } from '../src/storage.js';

test('local private storage prevents path traversal and overwriting existing evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fmo-storage-test-'));
  try {
    const storage = new LocalStorage(directory); const key = `selfies/${randomUUID()}.jpg`; const bytes = Buffer.from('private-test-bytes');
    await storage.put(key, bytes); assert.deepEqual(await storage.get(key), bytes);
    await assert.rejects(storage.put(key, Buffer.from('overwrite')));
    for (const invalid of ['../outside.jpg', '/absolute.jpg', 'selfies/../../outside.jpg', 'https://example.com/a.jpg']) {
      await assert.rejects(storage.get(invalid)); await assert.rejects(storage.put(invalid, bytes));
    }
  } finally {
    if (resolve(directory).startsWith(resolve(tmpdir()) + sep + 'fmo-storage-test-')) await rm(directory, { recursive: true, force: true });
  }
});
test('selfie decoder strips metadata, rejects truncated images and enforces pixel limits', async () => {
  const image = await sharp({ create: { width: 240, height: 240, channels: 3, background: '#123456' } }).withMetadata().jpeg().toBuffer();
  const result = await sanitizeSelfie(image, 'image/jpeg');
  assert.equal((await sharp(result.image).metadata()).exif, undefined);
  await assert.rejects(sanitizeSelfie(image.subarray(0, 40), 'image/jpeg'));
  const oversize = await sharp({ create: { width: 6001, height: 160, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(sanitizeSelfie(oversize, 'image/png'));
});
test('S3 adapter performs signed private PUT/GET through the real AWS SDK', async () => {
  let stored = Buffer.alloc(0); const seen: string[] = [];
  // A local protocol fixture exercises SDK requests; this is not a cloud deployment test.
  const server = createServer(async (request, response) => {
    try {
      assert.match(String(request.headers.authorization), /^AWS4-HMAC-SHA256 /);
      assert.equal(request.headers['x-amz-acl'], undefined);
      const path = new URL(request.url!, 'http://localhost').pathname;
      assert.match(path, /^\/private-test\/selfies\/[a-f0-9-]+\.jpg$/);
      seen.push(request.method!);
      if (request.method === 'PUT') {
        assert.equal(request.headers['if-none-match'], '*');
        assert.match(String(request.headers['cache-control']), /private/);
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        stored = Buffer.concat(chunks); response.writeHead(200, { ETag: '"test-etag"' }); response.end();
      } else { response.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': stored.length }); response.end(stored); }
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const client = new S3Client({ endpoint: `http://127.0.0.1:${address.port}`, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' }, maxAttempts: 1 });
  try {
    const storage = new S3Storage(client, 'private-test'); const key = `selfies/${randomUUID()}.jpg`; const bytes = Buffer.from('private-object-content');
    await storage.put(key, bytes, 'image/jpeg'); assert.deepEqual(await storage.get(key), bytes); assert.deepEqual(seen, ['PUT', 'GET']);
  } finally { client.destroy(); await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); }
});
