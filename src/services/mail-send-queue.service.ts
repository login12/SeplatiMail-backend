import { MailSendStatus, Prisma } from '@prisma/client';
import { prisma } from '@/config/database';
import { logger } from '@/utils/logger';
import * as accountService from '@/services/account.service';
import * as smtpService from '@/services/smtp.service';
import { appendMessageToMailbox } from '@/services/imap.service';
import type { SendMailDto } from '@/types';

const activeJobs = new Set<string>();

export async function enqueueSend(userId: string, payload: SendMailDto) {
  const account = await prisma.mailAccount.findUnique({ where: { userId } });
  if (!account || !account.isActive) throw new Error('MAIL_ACCOUNT_NOT_FOUND');

  const job = await prisma.mailSendJob.create({
    data: {
      accountId: account.id,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
  });

  void processSendJob(job.id);
  return job;
}

export async function getSendStatus(userId: string, jobId: string) {
  const account = await prisma.mailAccount.findUnique({ where: { userId } });
  if (!account) return null;

  return prisma.mailSendJob.findFirst({
    where: { id: jobId, accountId: account.id },
    select: {
      id: true,
      status: true,
      messageId: true,
      error: true,
      attempts: true,
      sentAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function resumePendingSendJobs(): Promise<void> {
  const jobs = await prisma.mailSendJob.findMany({
    where: {
      status: {
        in: [
          MailSendStatus.QUEUED,
          MailSendStatus.SENDING,
          MailSendStatus.APPENDING,
          MailSendStatus.APPEND_FAILED,
        ],
      },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  for (const job of jobs) {
    void processSendJob(job.id);
  }
}

export async function processSendJob(jobId: string): Promise<void> {
  if (activeJobs.has(jobId)) return;
  activeJobs.add(jobId);

  try {
    const job = await prisma.mailSendJob.findUnique({
      where: { id: jobId },
      include: { account: true },
    });

    if (!job || job.status === MailSendStatus.SENT) return;

    if (job.messageId && job.rawMessage) {
      await appendSentCopy(job.id, job.account.userId, job.messageId, Buffer.from(job.rawMessage));
      return;
    }

    await prisma.mailSendJob.update({
      where: { id: jobId },
      data: {
        status: MailSendStatus.SENDING,
        attempts: { increment: 1 },
        error: null,
      },
    });

    const dto = job.payload as unknown as SendMailDto;
    const [smtpConfig, imapConfig] = await Promise.all([
      accountService.getSmtpConfig(job.account.userId),
      accountService.getImapConfig(job.account.userId),
    ]);

    const { messageId, raw } = await smtpService.sendEmail(smtpConfig, dto);

    await prisma.mailSendJob.update({
      where: { id: jobId },
      data: {
        status: MailSendStatus.APPENDING,
        messageId,
        rawMessage: raw,
        sentAt: new Date(),
        error: null,
      },
    });

    try {
      await appendMessageToMailbox(imapConfig, 'Sent', raw, ['\\Seen'], messageId);

      await prisma.mailSendJob.update({
        where: { id: jobId },
        data: {
          status: MailSendStatus.SENT,
          rawMessage: null,
          error: null,
        },
      });
    } catch (err) {
      logger.error({ err, jobId, msg: 'Email sent but failed to append to Sent folder' });
      await prisma.mailSendJob.update({
        where: { id: jobId },
        data: {
          status: MailSendStatus.APPEND_FAILED,
          error: err instanceof Error ? err.message : 'Sent email could not be saved to IMAP Sent folder',
        },
      });
      scheduleAppendRetry(jobId);
    }
  } catch (err) {
    logger.error({ err, jobId, msg: 'Failed to process send job' });
    await prisma.mailSendJob.update({
      where: { id: jobId },
      data: {
        status: MailSendStatus.FAILED,
        error: err instanceof Error ? err.message : 'Unknown send error',
      },
    }).catch(() => undefined);
  } finally {
    activeJobs.delete(jobId);
  }
}

async function appendSentCopy(jobId: string, userId: string, messageId: string, raw: Buffer): Promise<void> {
  try {
    await prisma.mailSendJob.update({
      where: { id: jobId },
      data: {
        status: MailSendStatus.APPENDING,
        error: null,
      },
    });

    const imapConfig = await accountService.getImapConfig(userId);
    await appendMessageToMailbox(imapConfig, 'Sent', raw, ['\\Seen'], messageId);

    await prisma.mailSendJob.update({
      where: { id: jobId },
      data: {
        status: MailSendStatus.SENT,
        rawMessage: null,
        error: null,
      },
    });
  } catch (err) {
    logger.error({ err, jobId, msg: 'Failed to append already sent email to Sent folder' });
    await prisma.mailSendJob.update({
      where: { id: jobId },
      data: {
        status: MailSendStatus.APPEND_FAILED,
        error: err instanceof Error ? err.message : 'Sent email could not be saved to IMAP Sent folder',
      },
    }).catch(() => undefined);
    scheduleAppendRetry(jobId);
  }
}

function scheduleAppendRetry(jobId: string): void {
  const timer = setTimeout(() => void processSendJob(jobId), 30_000);
  timer.unref?.();
}
