import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { prisma } from '@/config/database';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '@/utils/jwt';
import { encrypt } from '@/utils/crypto';
import { env } from '@/config/env';
import { testMailConnection } from '@/services/account.service';
import { logger } from '@/utils/logger';
import type { LoginDto, UserDto } from '@/types';

const SALT_ROUNDS = 12;

// ─── Types ────────────────────────────────────────────────────────────────────

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface LoginResult {
  user: UserDto;
  tokens: TokenPair;
  sessionId: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapUserToDto(user: {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'USER';
  mailAccount: null | object;
}): UserDto {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    hasMailAccount: user.mailAccount !== null,
  };
}

// ─── Service Functions ────────────────────────────────────────────────────────

export async function loginUser(
  dto: LoginDto,
  meta: { userAgent?: string; ipAddress?: string }
): Promise<LoginResult> {
  const email = dto.email.toLowerCase().trim();

  // 1. Authenticate against IMAP Server directly
  const connectionTest = await testMailConnection({
    emailAddress: email,
    password: dto.password,
    imapHost: env.IMAP_HOST,
    imapPort: env.IMAP_PORT,
    imapSecure: env.IMAP_SECURE,
    smtpHost: env.SMTP_HOST,
    smtpPort: env.SMTP_PORT,
    smtpSecure: env.SMTP_SECURE,
  });

  if (!connectionTest.imap) {
    logger.warn({ email, msg: 'IMAP authentication failed during login attempt' });
    throw new Error('INVALID_CREDENTIALS');
  }

  // 2. Authentication successful via IMAP. Create or update User in DB.
  let user = await prisma.user.findUnique({
    where: { email },
    include: { mailAccount: true },
  });

  const encryptedPassword = encrypt(dto.password);

  if (!user) {
    // First login -> create the user automatically
    const dummyHash = await bcrypt.hash(randomUUID(), SALT_ROUNDS); // Not used for auth anymore
    user = await prisma.user.create({
      data: {
        name: email.split('@')[0], // Simple fallback name
        email,
        passwordHash: dummyHash,
        role: 'USER',
        mailAccount: {
          create: {
            emailAddress: email,
            imapHost: env.IMAP_HOST,
            imapPort: env.IMAP_PORT,
            imapSecure: env.IMAP_SECURE,
            smtpHost: env.SMTP_HOST,
            smtpPort: env.SMTP_PORT,
            smtpSecure: env.SMTP_SECURE,
            encryptedPassword,
          }
        }
      },
      include: { mailAccount: true },
    });
    logger.info({ userId: user.id, msg: 'New user created via IMAP auth' });
  } else {
    // Existing user -> upsert their mail account to refresh the encrypted password if it changed
    await prisma.mailAccount.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        emailAddress: email,
        imapHost: env.IMAP_HOST,
        imapPort: env.IMAP_PORT,
        imapSecure: env.IMAP_SECURE,
        smtpHost: env.SMTP_HOST,
        smtpPort: env.SMTP_PORT,
        smtpSecure: env.SMTP_SECURE,
        encryptedPassword,
      },
      update: {
        imapHost: env.IMAP_HOST,
        imapPort: env.IMAP_PORT,
        imapSecure: env.IMAP_SECURE,
        smtpHost: env.SMTP_HOST,
        smtpPort: env.SMTP_PORT,
        smtpSecure: env.SMTP_SECURE,
        encryptedPassword,
      }
    });
    // refresh the user object relation
    user = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { mailAccount: true }
    });
  }

  const sessionId = randomUUID();
  const accessToken = signAccessToken({ sub: user.id, email: user.email });
  const refreshToken = signRefreshToken({ sub: user.id, jti: sessionId });

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await prisma.session.create({
    data: {
      id: sessionId,
      userId: user.id,
      refreshToken,
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
      expiresAt,
    },
  });

  logger.info({ userId: user.id, msg: 'User logged in successfully' });

  return {
    user: mapUserToDto(user),
    tokens: { accessToken, refreshToken },
    sessionId,
  };
}

export async function refreshTokens(token: string): Promise<TokenPair> {
  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw new Error('INVALID_REFRESH_TOKEN');
  }

  const session = await prisma.session.findUnique({
    where: { refreshToken: token },
  });

  if (!session || session.expiresAt < new Date()) {
    throw new Error('SESSION_EXPIRED');
  }

  // Rotate refresh token (prevent token reuse)
  const newSessionId = randomUUID();
  const newAccessToken = signAccessToken({ sub: payload.sub, email: '' }); // email refreshed from DB
  const newRefreshToken = signRefreshToken({ sub: payload.sub, jti: newSessionId });

  const newExpiresAt = new Date();
  newExpiresAt.setDate(newExpiresAt.getDate() + 7);

  // Delete old session, create new one (rotation)
  await prisma.$transaction([
    prisma.session.deleteMany({ where: { id: session.id } }),
    prisma.session.create({
      data: {
        id: newSessionId,
        userId: payload.sub,
        refreshToken: newRefreshToken,
        userAgent: session.userAgent,
        ipAddress: session.ipAddress,
        expiresAt: newExpiresAt,
      },
    }),
  ]);

  return { accessToken: newAccessToken, refreshToken: newRefreshToken };
}

export async function logoutUser(refreshToken: string): Promise<void> {
  await prisma.session.deleteMany({ where: { refreshToken } });
}

export async function getUserById(userId: string): Promise<UserDto | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, isActive: true },
    include: { mailAccount: true },
  });

  if (!user) return null;
  return mapUserToDto({ ...user, mailAccount: user.mailAccount });
}

export async function createUser(data: {
  name: string;
  email: string;
  password: string;
  role?: 'ADMIN' | 'USER';
}): Promise<UserDto> {
  const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      name: data.name,
      email: data.email.toLowerCase().trim(),
      passwordHash,
      role: data.role ?? 'USER',
    },
    include: { mailAccount: true },
  });

  return mapUserToDto({ ...user, mailAccount: user.mailAccount });
}
