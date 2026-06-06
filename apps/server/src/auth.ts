import type { FastifyRequest, FastifyReply } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { eq } from 'drizzle-orm';
import { db } from './db/client.ts';
import { users } from './db/schema.ts';

export type AuthUser = { id: string; email: string; role: string };
export type AuthenticatedRequest = FastifyRequest & { authUser?: AuthUser };

const weakProductionSecrets = new Set(['dev-secret-change-me', 'change-me-in-production', 'change-me-in-dev']);

function jwtSecret(): Uint8Array {
  const raw = process.env.JWT_SECRET;
  if (!raw && process.env.NODE_ENV !== 'production') return new TextEncoder().encode('dev-secret-change-me');
  if (!raw) throw new Error('JWT_SECRET is required in production');
  if (process.env.NODE_ENV === 'production' && (raw.length < 32 || weakProductionSecrets.has(raw))) {
    throw new Error('JWT_SECRET must be at least 32 characters and not use an insecure default');
  }
  return new TextEncoder().encode(raw);
}

export async function signSession(user: AuthUser): Promise<string> {
  return new SignJWT({ sub: user.id }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('7d').sign(jwtSecret());
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const token = request.cookies.session;
  if (!token) { await reply.code(401).send({ error: 'auth_required' }); return null; }
  try {
    const verified = await jwtVerify(token, jwtSecret());
    const payload = verified.payload as { sub?: string; id?: string };
    const userId = payload.sub ?? payload.id;
    if (!userId) throw new Error('session_missing_subject');
    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!row) throw new Error('session_user_not_found');
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
