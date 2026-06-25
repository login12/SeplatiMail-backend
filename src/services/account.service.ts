import { prisma } from '@/config/database';
import { encrypt, decrypt } from '@/utils/crypto';
import { verifySmtpConnection } from '@/services/smtp.service';
import type { SetupMailAccountDto } from '@/types';
import type { ImapConfig } from '@/services/imap.service';
import type { SmtpConfig } from '@/services/smtp.service';

/**
 * Saves or updates a user's mail account configuration.
 * The password is encrypted before storing.
 */
export async function setupMailAccount(
  userId: string,
  dto: SetupMailAccountDto
): Promise<void> {
  const encryptedPassword = encrypt(dto.password);

  await prisma.mailAccount.upsert({
    where: { userId },
    create: {
      userId,
      emailAddress: dto.emailAddress,
      displayName: dto.displayName,
      imapHost: dto.imapHost,
      imapPort: dto.imapPort,
      imapSecure: dto.imapSecure,
      smtpHost: dto.smtpHost,
      smtpPort: dto.smtpPort,
      smtpSecure: dto.smtpSecure,
      encryptedPassword,
    },
    update: {
      emailAddress: dto.emailAddress,
      displayName: dto.displayName,
      imapHost: dto.imapHost,
      imapPort: dto.imapPort,
      imapSecure: dto.imapSecure,
      smtpHost: dto.smtpHost,
      smtpPort: dto.smtpPort,
      smtpSecure: dto.smtpSecure,
      encryptedPassword,
    },
  });
}

/**
 * Retrieves decrypted IMAP config for a user.
 */
export async function getImapConfig(userId: string): Promise<ImapConfig> {
  const account = await prisma.mailAccount.findUnique({ where: { userId } });
  if (!account || !account.isActive) throw new Error('MAIL_ACCOUNT_NOT_FOUND');

  return {
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    email: account.emailAddress,
    password: decrypt(account.encryptedPassword),
  };
}

/**
 * Retrieves decrypted SMTP config for a user.
 */
export async function getSmtpConfig(userId: string): Promise<SmtpConfig> {
  const account = await prisma.mailAccount.findUnique({ where: { userId } });
  if (!account || !account.isActive) throw new Error('MAIL_ACCOUNT_NOT_FOUND');

  return {
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    email: account.emailAddress,
    password: decrypt(account.encryptedPassword),
    displayName: account.displayName ?? undefined,
  };
}

/**
 * Tests SMTP and IMAP connectivity for a setup DTO without saving.
 */
export async function testMailConnection(dto: SetupMailAccountDto): Promise<{
  smtp: boolean;
  imap: boolean;
}> {
  const smtpResult = await verifySmtpConnection({
    host: dto.smtpHost,
    port: dto.smtpPort,
    secure: dto.smtpSecure,
    email: dto.emailAddress,
    password: dto.password,
    displayName: dto.displayName,
  });

  // Simple IMAP test via imapflow
  const { ImapFlow } = await import('imapflow');
  const imapClient = new ImapFlow({
    host: dto.imapHost,
    port: dto.imapPort,
    secure: dto.imapSecure,
    auth: { user: dto.emailAddress, pass: dto.password },
    logger: false,
    tls: { rejectUnauthorized: true },
  });

  let imapResult = false;
  try {
    await imapClient.connect();
    imapResult = true;
    await imapClient.logout();
  } catch {
    imapResult = false;
  }

  return { smtp: smtpResult, imap: imapResult };
}
