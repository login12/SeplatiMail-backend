import type { FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '@/utils/logger';

/**
 * Global error handler for Fastify.
 * Catches unhandled errors from route handlers and formats them consistently.
 */
export function errorHandler(
  error: Error & { statusCode?: number; validation?: unknown },
  req: FastifyRequest,
  reply: FastifyReply
): void {
  logger.error({
    msg: 'Unhandled route error',
    url: req.url,
    method: req.method,
    error: error.message,
    stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
  });

  const statusCode = error.statusCode ?? 500;

  if (error.validation) {
    reply.status(400).send({
      success: false,
      error: 'Validation error',
      details: error.validation,
    });
    return;
  }

  reply.status(statusCode).send({
    success: false,
    error:
      process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : error.message,
  });
}
