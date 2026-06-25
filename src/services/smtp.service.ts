import nodemailer from 'nodemailer';
import { logger } from '@/utils/logger';
import type { SendMailDto } from '@/types';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  email: string;
  password: string;
  displayName?: string;
}

/**
 * Sends an e-mail via SMTP using the provided account credentials.
 */
export async function sendEmail(config: SmtpConfig, dto: SendMailDto): Promise<{ messageId: string; raw: Buffer }> {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.email,
      pass: config.password,
    },
    tls: {
      rejectUnauthorized: true, // Enforce TLS certificate validation
    },
  });

  // Verify connection before sending
  await transporter.verify();

  const fromHeader = config.displayName
    ? `"${config.displayName}" <${config.email}>`
    : config.email;

  const mailOptions = {
    from: fromHeader,
    to: dto.to.join(', '),
    cc: dto.cc?.join(', '),
    bcc: dto.bcc?.join(', '),
    subject: dto.subject,
    html: dto.bodyHtml,
    text: dto.bodyText,
    replyTo: dto.replyTo,
    inReplyTo: dto.inReplyTo,
    references: dto.references?.join(' '),
  };

  const result = await transporter.sendMail(mailOptions);
  const raw = await buildRawMessage({ ...mailOptions, messageId: result.messageId, date: new Date() });

  logger.info({
    messageId: result.messageId,
    to: dto.to,
    subject: dto.subject,
    msg: 'Email sent successfully',
  });

  return { messageId: result.messageId, raw };
}

async function buildRawMessage(mailOptions: Record<string, unknown>): Promise<Buffer> {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'unix',
  });

  const result = await transport.sendMail(mailOptions);
  const message = result.message;
  return Buffer.isBuffer(message) ? message : Buffer.from(String(message));
}

/**
 * Tests SMTP connection with the provided credentials.
 */
export async function verifySmtpConnection(config: SmtpConfig): Promise<boolean> {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.email,
      pass: config.password,
    },
    tls: { rejectUnauthorized: true },
  });

  try {
    await transporter.verify();
    return true;
  } catch (err) {
    logger.error({ err, msg: 'SMTP connection verification failed' });
    return false;
  }
}
