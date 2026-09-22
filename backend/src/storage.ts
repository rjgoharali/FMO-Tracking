import { mkdir, writeFile, readFile, realpath, stat } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import type { parseEnv } from './config.js';
import { fail } from './errors.js';

export interface PrivateStorage { put(key: string, data: Buffer, contentType: string): Promise<void>; get(key: string): Promise<Buffer> }
export function validateStorageKey(key: string) {
  if (!/^(selfies\/[a-f0-9-]{36}\.jpg|demo\/placeholder-not-a-selfie\.png)$/.test(key)) throw new Error('Invalid private storage key');
}
export class LocalStorage implements PrivateStorage {
  private root: string;
  constructor(root: string) { this.root = resolve(root); }
  private async path(key: string, create: boolean) {
    validateStorageKey(key);
    if (create) await mkdir(dirname(resolve(this.root, key)), { recursive: true, mode: 0o700 });
    const root = await realpath(this.root);
    const parent = await realpath(dirname(resolve(this.root, key)));
    if (!parent.startsWith(root + sep)) throw new Error('Storage path escapes root');
    return resolve(parent, key.split('/')[1]!);
  }
  async put(key: string, data: Buffer) { await writeFile(await this.path(key, true), data, { flag: 'wx', mode: 0o600 }); }
  async get(key: string) {
    const file = await this.path(key, false);
    const canonical = await realpath(file);
    if (!canonical.startsWith((await realpath(this.root)) + sep)) throw new Error('Storage path escapes root');
    if ((await stat(canonical)).size > 5 * 1024 * 1024) throw new Error('Stored image exceeds limit');
    return readFile(canonical);
  }
}
export class S3Storage implements PrivateStorage {
  constructor(private client: S3Client, private bucket: string) {}
  async put(key: string, data: Buffer, contentType: string) {
    validateStorageKey(key);
    // No public ACL or public URL; the bucket must disallow public access.
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType,
      CacheControl: 'private, no-store', IfNoneMatch: '*' }), { abortSignal: AbortSignal.timeout(15000) });
  }
  async get(key: string) {
    validateStorageKey(key);
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: AbortSignal.timeout(15000) });
    if (!result.Body) throw new Error('Image not found');
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      length += chunk.length;
      if (length > 5 * 1024 * 1024) throw new Error('Stored image exceeds limit');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
export function createStorage(env: ReturnType<typeof parseEnv>): PrivateStorage {
  if (env.STORAGE_PROVIDER === 'local') return new LocalStorage(env.STORAGE_LOCAL_PATH);
  return new S3Storage(new S3Client({ region: env.STORAGE_REGION, endpoint: env.STORAGE_ENDPOINT || undefined,
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    ...(env.STORAGE_ACCESS_KEY && env.STORAGE_SECRET_KEY ? { credentials: { accessKeyId: env.STORAGE_ACCESS_KEY, secretAccessKey: env.STORAGE_SECRET_KEY } } : {}) }), env.STORAGE_BUCKET!);
}
export async function sanitizeSelfie(data: Buffer, mime: string) {
  if (data.length === 0 || data.length > 5 * 1024 * 1024) fail(413, 'IMAGE_SIZE', 'Selfie must be no larger than 5 MB');
  const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const png = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (!(jpeg && mime === 'image/jpeg') && !(png && mime === 'image/png')) fail(400, 'IMAGE_TYPE', 'Provide a camera JPEG or PNG image');
  try {
    const processor = sharp(data, { limitInputPixels: 20000000, failOn: 'warning' });
    const meta = await processor.metadata();
    if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < 160 || Math.max(meta.width, meta.height) > 6000 || (meta.pages ?? 1) !== 1) {
      fail(400, 'IMAGE_DIMENSIONS', 'Selfie must be a single image between 160 and 6000 pixels per side');
    }
    // Fully decode, auto-orient, resize and re-encode. EXIF/GPS and other metadata are stripped.
    const image = await processor.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    return { image, hash: createHash('sha256').update(image).digest('hex') };
  } catch (error) {
    if (error instanceof Error && 'statusCode' in error) throw error;
    fail(400, 'INVALID_IMAGE', 'Selfie could not be decoded. Capture a new photo');
  }
}
export interface SelfieVerifier { verify(image: Buffer): Promise<{ status: 'NOT_VERIFIED' | 'VERIFIED' | 'REJECTED' }> }
export const noBiometricVerification: SelfieVerifier = { async verify() { return { status: 'NOT_VERIFIED' }; } };
