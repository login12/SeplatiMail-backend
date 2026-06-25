import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.routes';
import { mailRoutes } from './mail.routes';

export async function registerRoutes(fastify: FastifyInstance, prefix: string) {
  fastify.register(authRoutes, { prefix: `${prefix}/auth` });
  fastify.register(mailRoutes, { prefix: `${prefix}/mail` });

  // Health check endpoint
  fastify.get('/health', async () => ({
    status: 'ok',
    service: 'seplati-mail-api',
    timestamp: new Date().toISOString(),
  }));
}
