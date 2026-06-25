import type { FastifyInstance } from 'fastify';
import * as authController from '@/controllers/auth.controller';

export async function authRoutes(fastify: FastifyInstance) {
  // POST /api/v1/auth/login
  fastify.post('/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: authController.login,
  });

  // POST /api/v1/auth/logout
  fastify.post('/logout', authController.logout);

  // POST /api/v1/auth/refresh
  fastify.post('/refresh', authController.refresh);

  // GET /api/v1/auth/me  (protected)
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    handler: authController.me,
  });
}
