import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken } from '@/utils/jwt';
import { logger } from '@/utils/logger';

/**
 * Authentication middleware.
 * Reads the access_token from HttpOnly cookie and injects userId into request.
 * Returns 401 if token is missing or invalid.
 */
export async function authenticate(
  req: FastifyRequest & { userId?: string },
  reply: FastifyReply
): Promise<void> {
  const token = req.cookies?.access_token;

  if (!token) {
    reply.status(401).send({ success: false, error: 'Authentication required' });
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.sub;
  } catch (err) {
    logger.warn({ msg: 'Invalid access token presented', err });
    reply.status(401).send({ success: false, error: 'Invalid or expired session' });
    return;
  }
}
