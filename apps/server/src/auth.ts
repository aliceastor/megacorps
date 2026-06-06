import type { FastifyRequest, FastifyReply } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from './db/client.ts';
import { appSettings, users } from './db/schema.ts';

export type AuthUser = { id: string; email: string; role: string };
export type AuthenticatedRequest = FastifyRequest & { authUser?: AuthUser };

let cachedSessionSecret: Uint8Array | null = null;

async function sessionSecret(): Promise<Uint8Array> {
  if (cachedSessionSecret) return cachedSessionSecret;
  const generated = randomBytes(32).toString('base64');
  await db.insert(appSettings).values({ key: 'auth.jwt_secret', value: generated }).onConflictDoNothing();
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, 'auth.jwt_secret')).limit(1);
  const raw = row?.value ?? generated;
  if (raw.length < 32) throw new Error('DB auth.jwt_secret must be at least 32 characters');
  cachedSessionSecret = new TextEncoder().encode(raw);
  return cachedSessionSecret;
}

export async function assertSessionSecretReady(): Promise<void> {
  await sessionSecret();
}

export async function signSession(user: AuthUser): Promise<string> {
  return new SignJWT({ sub: user.id }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('7d').sign(await sessionSecret());
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const token = request.cookies.session;
  if (!token) { await reply.code(401).send({ error: 'auth_required' }); return null; }
  try {
    const verified = await jwtVerify(token, await sessionSecret());
    const payload = verified.payload as { sub?: string; id?: string };
    const userId = payload.sub ?? payload.id;
    if (!userId) throw new Error('session_missing_subject');
    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!row) throw new Error('session_user_not_found');
    if (row.status === 'disabled') {
      await reply.code(403).send({ error: 'user_disabled' });
      return null;
    }
    const user: AuthUser = { id: row.id, email: row.email, role: row.role ?? 'viewer' };
    (request as AuthenticatedRequest).authUser = user;
    return user;
  } catch {
    await reply.code(401).send({ error: 'auth_expired' });
    return null;
  }
}

const roleRank: Record<string, number> = { viewer: 0, operator: 1, admin: 2 };

export async function requireRole(request: FastifyRequest, reply: FastifyReply, minimumRole: 'viewer' | 'operator' | 'admin'): Promise<AuthUser | null> {
  const user = await requireAuth(request, reply);
  if (!user) return null;
  const actual = roleRank[user.role] ?? 0;
  const required = roleRank[minimumRole] ?? 0;
  if (actual < required) {
    await reply.code(403).send({ error: 'forbidden', requiredRole: minimumRole });
    return null;
  }
  return user;
}
