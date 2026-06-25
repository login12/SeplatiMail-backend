import { PrismaClient } from '@prisma/client';
import { logger } from '@/utils/logger';

declare global {
  // Prevent multiple Prisma instances in development hot-reload
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
  });

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}

prisma.$on('error' as never, (e: { message: string }) => {
  logger.error({ msg: 'Prisma error', error: e.message });
});

prisma.$on('warn' as never, (e: { message: string }) => {
  logger.warn({ msg: 'Prisma warning', warning: e.message });
});
