import type { FastifyRequest, FastifyReply } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret-change-me');
export type AuthUser = { id: string; email: string; role: string };
export type AuthenticatedRequest = FastifyRequest & { authUser?: AuthUser };

export async function signSession(user: AuthUser): Promise<string> {
  return new SignJWT(user).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('7d').sign(secret);
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const token = request.cookies.session;
  if (!token) { await reply.code(401).send({ error: 'auth_required' }); return null; }
  try {
    const verified = await jwtVerify(token, secret);
    const user = verified.payload as AuthUser;
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
