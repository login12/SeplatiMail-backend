import type { FastifyInstance } from 'fastify';
import * as mailController from '@/controllers/mail.controller';

export async function mailRoutes(fastify: FastifyInstance) {
  // All mail routes require authentication
  fastify.addHook('preHandler', fastify.authenticate);

  // ─── Account Setup ──────────────────────────────────────────────────────────
  // POST /api/v1/mail/account/setup
  fastify.post('/account/setup', mailController.setupAccount);

  // POST /api/v1/mail/account/test
  fastify.post('/account/test', mailController.testConnection);

  // ─── Folders ────────────────────────────────────────────────────────────────
  // GET /api/v1/mail/folders
  fastify.get('/folders', mailController.getFolders);

  // ─── Messages ───────────────────────────────────────────────────────────────
  // GET /api/v1/mail/messages?folder=INBOX&page=1&limit=40
  fastify.get('/messages', mailController.getMessages);

  // GET /api/v1/mail/messages/:uid/part?folder=INBOX&part=1.2
  fastify.get('/messages/:uid/part', mailController.getMessagePart);

  // GET /api/v1/mail/messages/:uid?folder=INBOX
  fastify.get('/messages/:uid', mailController.getMessage);

  // PATCH /api/v1/mail/messages/:uid/flags?folder=INBOX
  fastify.patch('/messages/:uid/flags', mailController.updateFlags);

  // DELETE /api/v1/mail/messages/:uid?folder=INBOX
  fastify.delete('/messages/:uid', mailController.deleteMessage);

  // POST /api/v1/mail/messages/permanent-delete?folder=Trash
  fastify.post('/messages/permanent-delete', mailController.permanentlyDeleteMessages);

  // POST /api/v1/mail/messages/empty?folder=Trash
  fastify.post('/messages/empty', mailController.emptyFolder);

  // POST /api/v1/mail/messages/move?folder=Trash
  fastify.post('/messages/move', mailController.moveMessages);

  // POST /api/v1/mail/send
  fastify.post('/send', mailController.sendMail);

  // GET /api/v1/mail/send/:jobId
  fastify.get('/send/:jobId', mailController.getSendStatus);

  // GET /api/v1/mail/events?folder=INBOX
  fastify.get('/events', mailController.streamEvents);
}
