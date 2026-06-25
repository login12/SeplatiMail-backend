import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import * as mailCacheService from '@/services/mail-cache.service';
import * as accountService from '@/services/account.service';
import * as mailSendQueueService from '@/services/mail-send-queue.service';
import { watchMailbox } from '@/services/imap.service';
import { logger } from '@/utils/logger';

type AuthRequest = FastifyRequest & { userId: string };

// ─── Validation Schemas ───────────────────────────────────────────────────────

const listMessagesSchema = z.object({
  folder: z.string().default('INBOX'),
  page: z.string().default('1').transform(Number),
  limit: z.string().default('40').transform(Number),
});

const flagsSchema = z.object({
  action: z.enum(['add', 'remove']),
  flags: z.array(z.string()).min(1),
});

const bulkUidsSchema = z.object({
  uids: z.array(z.number().int().positive()).min(1),
});

const moveMessagesSchema = z.object({
  uids: z.array(z.number().int().positive()).min(1),
  destinationFolder: z.string().min(1),
});

const sendMailSchema = z.object({
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1),
  bodyHtml: z.string().min(1),
  bodyText: z.string().optional(),
  replyTo: z.string().email().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
});

const setupAccountSchema = z.object({
  emailAddress: z.string().email(),
  displayName: z.string().optional(),
  password: z.string().min(1),
  imapHost: z.string().min(1),
  imapPort: z.number().int().min(1).max(65535),
  imapSecure: z.boolean().default(true),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean().default(true),
});

// ─── Mail Account ─────────────────────────────────────────────────────────────

export async function setupAccount(req: FastifyRequest, reply: FastifyReply) {
  const parsed = setupAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.status(400).send({
      success: false,
      error: 'Validation error',
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { userId } = req as AuthRequest;

  try {
    await accountService.setupMailAccount(userId, parsed.data);
    return reply.status(200).send({
      success: true,
      data: { message: 'Mail account configured successfully' },
    });
  } catch (err) {
    logger.error({ err, userId, msg: 'Failed to setup mail account' });
    return reply.status(500).send({ success: false, error: 'Failed to save mail account' });
  }
}

export async function testConnection(req: FastifyRequest, reply: FastifyReply) {
  const parsed = setupAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.status(400).send({ success: false, error: 'Validation error' });
  }

  const result = await accountService.testMailConnection(parsed.data);
  return reply.status(200).send({ success: true, data: result });
}

// ─── Folders ─────────────────────────────────────────────────────────────────

export async function getFolders(req: FastifyRequest, reply: FastifyReply) {
  const { userId } = req as AuthRequest;

  try {
    const folders = await mailCacheService.listFolders(userId);
    return reply.status(200).send({ success: true, data: { folders } });
  } catch (err) {
    if (err instanceof Error && err.message === 'MAIL_ACCOUNT_NOT_FOUND') {
      return reply.status(404).send({ success: false, error: 'Mail account not configured' });
    }
    logger.error({ err, userId, msg: 'Failed to list folders' });
    return reply.status(500).send({ success: false, error: 'Failed to fetch folders' });
  }
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export async function getMessages(req: FastifyRequest, reply: FastifyReply) {
  const { userId } = req as AuthRequest;
  const query = listMessagesSchema.safeParse(req.query);

  if (!query.success) {
    return reply.status(400).send({ success: false, error: 'Invalid query params' });
  }

  try {
    const { messages, total } = await mailCacheService.listMessages(
      userId,
      query.data.folder,
      query.data.page,
      query.data.limit
    );

    return reply.status(200).send({
      success: true,
      data: {
        messages,
        total,
        page: query.data.page,
        limit: query.data.limit,
        totalPages: Math.ceil(total / query.data.limit),
      },
    });
  } catch (err) {
    logger.error({ err, userId, msg: 'Failed to list messages' });
    return reply.status(500).send({ success: false, error: 'Failed to fetch messages' });
  }
}

export async function getMessage(req: FastifyRequest, reply: FastifyReply) {
  const { userId } = req as AuthRequest;
  const { uid } = req.params as { uid: string };
  const { folder } = req.query as { folder?: string };

  const parsedUid = parseInt(uid, 10);
  if (isNaN(parsedUid)) {
    return reply.status(400).send({ success: false, error: 'Invalid UID' });
  }

  try {
    const message = await mailCacheService.getMessage(userId, folder ?? 'INBOX', parsedUid);

    if (!message) {
      return reply.status(404).send({ success: false, error: 'Message not found' });
    }

    return reply.status(200).send({ success: true, data: { message } });
  } catch (err) {
    logger.error({ err, userId, uid, msg: 'Failed to get message' });
    return reply.status(500).send({ success: false, error: 'Failed to fetch message' });
  }
}

export async function getMessagePart(req: FastifyRequest, reply: FastifyReply) {
  const { userId } = req as AuthRequest;
  const { uid } = req.params as { uid: string };
  const { folder, part } = req.query as { folder?: string; part?: string };

  const parsedUid = parseInt(uid, 10);
  if (isNaN(parsedUid) || !part) {
    return reply.status(400).send({ success: false, error: 'Invalid request' });
  }

  try {
    const result = await mailCacheService.downloadMessagePart(userId, folder ?? 'INBOX', parsedUid, part);

    if (!result) {
      return reply.status(404).send({ success: false, error: 'Message part not found' });
    }

    return reply
      .header('Content-Type', result.mimeType)
      .header('Content-Disposition', `inline; filename="${encodeURIComponent(result.filename)}"`)
      .header('Cache-Control', 'private, max-age=3600')
      .send(result.content);
  } catch (err) {
    logger.error({ err, userId, uid, part, msg: 'Failed to download message part' });
    return reply.status(500).send({ success: false, error: 'Failed to download message part' });
  }
}

export async function streamEvents(req: FastifyRequest, reply: FastifyReply) {
  const { userId } = req as AuthRequest;
  const { folder } = req.query as { folder?: string };
  const targetFolder = folder ?? 'INBOX';

  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('ready', { folder: targetFolder });

  let stop: (() => void) | undefined;
  const heartbeat = setInterval(() => {
    reply.raw.write(': keepalive\n\n');
  }, 25_000);

  req.raw.on('close', () => {
    clearInterval(heartbeat);
    stop?.();
  });

  try {
    const config = await accountService.getImapConfig(userId);
    stop = await watchMailbox(config, targetFolder, (event) => {
      send('mailbox-changed', { folder: targetFolder, count: event.count, prevCount: event.prevCount });
    });
  } catch (err) {
    clearInterval(heartbeat);
    stop?.();
    logger.error({ err, userId, folder: targetFolder, msg: 'Failed to start mail event stream' });
    send('error', { error: 'Failed to watch mailbox' });
    reply.raw.end();
  }
}

export async function updateFlags(req: FastifyRequest, reply: FastifyReply) {
  const { userId } = req as AuthRequest;
  const { uid } = req.params as { uid: string };
  const { folder } = req.query as { folder?: string };

  const parsedUid = parseInt(uid, 10);
  const parsed = flagsSchema.safeParse(req.body);

  if (isNaN(parsedUid) || !parsed.success) {
    return reply.status(400).send({ success: false, error: 'Invalid request' });
  }

  try {
    await mailCacheService.updateMessageFlags(
      userId,
      folder ?? 'INBOX',
      parsedUid,
      parsed.data.action,
      parsed.data.flags
    );
    return reply.status(200).send({ success: true, data: { updated: true } });
  } catch (err) {
    logger.error({ err, userId, uid, msg: 'Failed to update flags' });
    return reply.status(500).send({ success: false, error: 'Failed to update message' });
  }
}

export async function deleteMessage(req: FastifyRequest, reply: FastifyReply) {
  const { userId } = req as AuthRequest;
  const { uid } = req.params as { uid: string };
  const { folder, trashFolder } = req.query as { folder?: string; trashFolder?: string };

  const parsedUid = parseInt(uid, 10);
  if (isNaN(parsedUid)) {
    return reply.status(400).send({ success: false, error: 'Invalid UID' });
  }

  try {
    await mailCacheService.deleteMessage(userId, folder ?? 'INBOX', parsedUid, trashFolder ?? 'Trash');
    return reply.status(200).send({ success: true, data: { deleted: true } });
  } catch (err) {
    logger.error({ err, userId, uid, msg: 'Failed to delete message' });
    return reply.status(500).send({ success: false, error: 'Failed to delete message' });
  }
}

export async function permanentlyDeleteMessages(req: FastifyRequest, reply: FastifyReply) {
  const { userId } = req as AuthRequest;
  const { folder } = req.query as { folder?: string };
  const parsed = bulkUidsSchema.safeParse(req.body);

  if (!parsed.success) {
    return reply.status(400).send({ success: false, error: 'Invalid request' });
  }

  try {
    const deleted = await mailCacheService.permanentlyDeleteMessages(userId, folder ?? 'Trash', parsed.data.uids);
    return reply.status(200).send({ success: true, data: { deleted } });
  } catch (err) {
    logger.error({ err, userId, folder, msg: 'Failed to permanently delete messages' });
    return reply.status(500).send({ success: false, error: 'Failed to permanently delete messages' });
  }
}

export async function emptyFolder(req: FastifyRequest, reply: FastifyReply) {
  const { userId } = req as AuthRequest;
  const { folder } = req.query as { folder?: string };

  try {
    const deleted = await mailCacheService.emptyFolder(userId, folder ?? 'Trash');
    return reply.status(200).send({ success: true, data: { deleted } });
  } catch (err) {
    logger.error({ err, userId, folder, msg: 'Failed to empty folder' });
    return reply.status(500).send({ success: false, error: 'Failed to empty folder' });
  }
}

export async function moveMessages(req: FastifyRequest, reply: FastifyReply) {
  const { userId } = req as AuthRequest;
  const { folder } = req.query as { folder?: string };
  const parsed = moveMessagesSchema.safeParse(req.body);

  if (!parsed.success) {
    return reply.status(400).send({ success: false, error: 'Invalid request' });
  }

  try {
    const moved = await mailCacheService.moveMessages(
      userId,
      folder ?? 'INBOX',
      parsed.data.destinationFolder,
      parsed.data.uids
    );
    return reply.status(200).send({ success: true, data: { moved } });
  } catch (err) {
    logger.error({ err, userId, folder, msg: 'Failed to move messages' });
    return reply.status(500).send({ success: false, error: 'Failed to move messages' });
  }
}

export async function sendMail(req: FastifyRequest, reply: FastifyReply) {
  const { userId } = req as AuthRequest;
  const parsed = sendMailSchema.safeParse(req.body);

  if (!parsed.success) {
    return reply.status(400).send({
      success: false,
      error: 'Validation error',
      details: parsed.error.flatten().fieldErrors,
    });
  }

  try {
    const job = await mailSendQueueService.enqueueSend(userId, parsed.data);
    return reply.status(202).send({ success: true, data: { jobId: job.id, status: job.status } });
  } catch (err) {
    logger.error({ err, userId, msg: 'Failed to send email' });
    return reply.status(500).send({ success: false, error: 'Failed to queue email' });
  }
}

export async function getSendStatus(req: FastifyRequest, reply: FastifyReply) {
  const { userId } = req as AuthRequest;
  const { jobId } = req.params as { jobId: string };

  try {
    const job = await mailSendQueueService.getSendStatus(userId, jobId);
    if (!job) return reply.status(404).send({ success: false, error: 'Send job not found' });
    return reply.status(200).send({ success: true, data: job });
  } catch (err) {
    logger.error({ err, userId, jobId, msg: 'Failed to get send status' });
    return reply.status(500).send({ success: false, error: 'Failed to get send status' });
  }
}
