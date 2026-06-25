import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import * as authService from '@/services/auth.service';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';

// ─── Validation Schemas ───────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

// ─── Cookie Config ────────────────────────────────────────────────────────────

const COOKIE_OPTIONS = {
  httpOnly: true,                          // Never accessible by JS
  secure: env.NODE_ENV === 'production',   // HTTPS only in production
  sameSite: 'strict' as const,            // CSRF protection
  path: '/',
};

const ACCESS_TOKEN_MAX_AGE = 15 * 60;         // 15 minutes in seconds
const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

// ─── Controllers ─────────────────────────────────────────────────────────────

export async function login(req: FastifyRequest, reply: FastifyReply) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.status(400).send({
      success: false,
      error: 'Validation error',
      details: parsed.error.flatten().fieldErrors,
    });
  }

  try {
    const result = await authService.loginUser(parsed.data, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });

    // Set tokens in HttpOnly cookies — NEVER in response body
    reply
      .setCookie('access_token', result.tokens.accessToken, {
        ...COOKIE_OPTIONS,
        maxAge: ACCESS_TOKEN_MAX_AGE,
      })
      .setCookie('refresh_token', result.tokens.refreshToken, {
        ...COOKIE_OPTIONS,
        maxAge: REFRESH_TOKEN_MAX_AGE,
      });

    return reply.status(200).send({
      success: true,
      data: { user: result.user },
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'INVALID_CREDENTIALS') {
      return reply.status(401).send({
        success: false,
        error: 'E-mail ou senha inválidos.',
      });
    }
    logger.error({ err, msg: 'Unexpected error during login' });
    return reply.status(500).send({ success: false, error: 'Internal server error' });
  }
}

export async function refresh(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies?.refresh_token;
  if (!token) {
    return reply.status(401).send({ success: false, error: 'No refresh token' });
  }

  try {
    const tokens = await authService.refreshTokens(token);

    reply
      .setCookie('access_token', tokens.accessToken, {
        ...COOKIE_OPTIONS,
        maxAge: ACCESS_TOKEN_MAX_AGE,
      })
      .setCookie('refresh_token', tokens.refreshToken, {
        ...COOKIE_OPTIONS,
        maxAge: REFRESH_TOKEN_MAX_AGE,
      });

    return reply.status(200).send({ success: true, data: { refreshed: true } });
  } catch {
    return reply.status(401).send({ success: false, error: 'Invalid or expired session' });
  }
}

export async function logout(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies?.refresh_token;
  if (token) {
    await authService.logoutUser(token);
  }

  reply
    .clearCookie('access_token', { path: '/' })
    .clearCookie('refresh_token', { path: '/' });

  return reply.status(200).send({ success: true, data: { message: 'Logged out' } });
}

export async function me(req: FastifyRequest, reply: FastifyReply) {
  // userId is injected by auth middleware
  const userId = (req as FastifyRequest & { userId: string }).userId;

  const user = await authService.getUserById(userId);
  if (!user) {
    return reply.status(404).send({ success: false, error: 'User not found' });
  }

  return reply.status(200).send({ success: true, data: { user } });
}
