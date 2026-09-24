import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const projectUrl = process.env.SUPABASE_URL;
const jwks = projectUrl ? createRemoteJWKSet(new URL(`${projectUrl}/auth/v1/.well-known/jwks.json`)) : null;

/** Verify a Supabase access token without storing a service-role secret. */
export async function verifySupabaseAccessToken(token: string): Promise<JWTPayload> {
  if (!jwks || !projectUrl) throw new Error('SUPABASE_URL is not configured');
  const result = await jwtVerify(token, jwks, { issuer: `${projectUrl}/auth/v1`, audience: 'authenticated' });
  return result.payload;
}
