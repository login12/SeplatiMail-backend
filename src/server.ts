import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { authenticate } from '@/middleware/auth.middleware';
import { errorHandler } from '@/middleware/errorHandler';
import { registerRoutes } from '@/routes';
import { prisma } from '@/config/database';
import { resumePendingSendJobs } from '@/services/mail-send-queue.service';

// ─── Extend Fastify with our authenticate decorator ───────────────────────────
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  const app = Fastify({
    logger: false, // We use our own pino logger
  });

  // ─── Security Plugins ────────────────────────────────────────────────────────

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
      },
    },
  });

  await app.register(cors, {
    origin: env.FRONTEND_URL,
    credentials: true, // Required for cookies
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      success: false,
      error: 'Too many requests. Please slow down.',
    }),
  });

  await app.register(cookie, {
    secret: env.COOKIE_SECRET,
    parseOptions: {},
  });

  // ─── Decorators ──────────────────────────────────────────────────────────────

  app.decorateRequest('userId', '');
  app.decorate('authenticate', authenticate);

  // ─── Error Handler ───────────────────────────────────────────────────────────

  app.setErrorHandler(errorHandler);

  // ─── Routes ──────────────────────────────────────────────────────────────────

  await registerRoutes(app, env.API_PREFIX);

  // ─── Startup ─────────────────────────────────────────────────────────────────

  try {
    await prisma.$connect();
    logger.info({ msg: '✅ Database connected' });
    await resumePendingSendJobs();
  } catch (err) {
    logger.error({ err, msg: '❌ Failed to connect to database' });
    process.exit(1);
  }

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info({ msg: `🚀 Seplati Mail API running on http://localhost:${env.PORT}` });
  logger.info({ msg: `📖 API prefix: ${env.API_PREFIX}` });

  // ─── Graceful Shutdown ───────────────────────────────────────────────────────

  const signals = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      logger.info({ msg: `${signal} received — shutting down gracefully` });
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    });
  }
}

bootstrap().catch((err) => {
  logger.error({ err, msg: 'Fatal error during startup' });
  process.exit(1);
});
