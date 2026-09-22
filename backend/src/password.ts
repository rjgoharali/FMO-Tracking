import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';

const cost = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
let active = 0;
const waiting: Array<() => void> = [];
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  // Bound memory consumption even when different IPs submit login requests together.
  if (active >= 2) {
    if (waiting.length >= 20) throw new ApiError(503, 'AUTH_BUSY', 'Authentication is busy. Please retry shortly');
    await new Promise<void>(resolve => waiting.push(resolve));
  } else active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => scryptCallback(password, salt, 64, cost, (error, key) => error ? reject(error) : resolve(key)));
  } finally {
    const next = waiting.shift();
    if (next) next(); else active--;
  }
}
export async function hashPassword(password: string) {
  if (password.length < 12 || Buffer.byteLength(password) > 1024) throw new Error('Password must be at least 12 characters and at most 1024 bytes');
  const salt = randomBytes(16);
  return `scrypt$131072$8$1$${salt.toString('hex')}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string) {
  if (Buffer.byteLength(password) > 1024) return false;
  const match = /^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(hash);
  if (!match) return false;
  return timingSafeEqual(await derive(password, Buffer.from(match[1]!, 'hex')), Buffer.from(match[2]!, 'hex'));
}
