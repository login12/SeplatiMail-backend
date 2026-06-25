import pino from 'pino';
import { env } from '@/config/env';

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport:
    env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  redact: {
    // Never log these fields — security measure
    paths: ['password', 'passwordHash', 'encryptedPass', 'accessToken', 'refreshToken'],
    censor: '[REDACTED]',
  },
});
