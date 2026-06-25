import { ImapFlow, type FetchMessageObject, type ListTreeResponse, type MessageStructureObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { sanitizeEmailHtml, htmlToPlainText } from '@/utils/sanitize';
import { logger } from '@/utils/logger';
import type {
  MailboxFolder,
  MailListItem,
  MailMessage,
  MailAddress,
} from '@/types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  email: string;
  password: string;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

function createImapClient(config: ImapConfig): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.email,
      pass: config.password,
    },
    logger: false, // Use our own logger
    tls: {
      rejectUnauthorized: true, // Always verify TLS certificate
    },
  });
}

export async function watchMailbox(
  config: ImapConfig,
  folder: string,
  onChange: (event: { path: string; count: number; prevCount: number }) => void
): Promise<() => void> {
  let closed = false;
  let changeTimer: NodeJS.Timeout | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let client: ImapFlow | undefined;
  let reconnectDelayMs = 1_000;

  const emitChange = (event: { path: string; count: number; prevCount: number }) => {
    if (closed) return;
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => onChange(event), 300);
  };

  const cleanupClient = () => {
    const current = client;
    client = undefined;
    if (!current) return;

    current.removeAllListeners('exists');
    current.removeAllListeners('error');
    current.removeAllListeners('close');
    current.logout().catch(() => undefined);
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    cleanupClient();

    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connectWatcher(false);
    }, reconnectDelayMs);
    reconnectTimer.unref?.();
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
  };

  const handleError = (err: Error & { code?: string }) => {
    if (closed) return;
    const log = err.code === 'ECONNRESET' ? logger.debug.bind(logger) : logger.warn.bind(logger);
    log({ err, folder, msg: 'IMAP watcher connection dropped' });
    scheduleReconnect();
  };

  const connectWatcher = async (initial: boolean) => {
    if (closed) return;

    try {
      const nextClient = createImapClient(config);
      client = nextClient;
      nextClient.on('exists', emitChange);
      nextClient.on('error', handleError);
      nextClient.once('close', scheduleReconnect);

      await nextClient.connect();
      const resolvedFolder = await resolveMailboxPath(nextClient, folder);
      await nextClient.mailboxOpen(resolvedFolder, { readOnly: true });
      (nextClient as unknown as { autoidle?: () => void }).autoidle?.();
      reconnectDelayMs = 1_000;
    } catch (err) {
      cleanupClient();
      if (initial) throw err;

      logger.warn({ err, folder, msg: 'Failed to reconnect IMAP watcher' });
      scheduleReconnect();
    }
  };

  await connectWatcher(true);

  return () => {
    closed = true;
    if (changeTimer) clearTimeout(changeTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    cleanupClient();
  };
}

export async function appendMessageToMailbox(
  config: ImapConfig,
  folder: string,
  content: Buffer,
  flags: string[] = ['\\Seen'],
  messageId?: string
): Promise<void> {
  return withImapClient(config, async (client) => {
    const resolvedFolder = await resolveMailboxPath(client, folder);
    const lock = await client.getMailboxLock(resolvedFolder);
    try {
      if (messageId) {
        const existing = await client.search({ header: { 'Message-ID': messageId } }, { uid: true });
        if (existing && existing.length > 0) return;
      }

      await client.append(resolvedFolder, content, flags, new Date());
    } finally {
      lock.release();
    }
  });
}

type PoolEntry = {
  client: ImapFlow;
  queue: Promise<void>;
  idleTimer?: NodeJS.Timeout;
};

const IMAP_IDLE_TTL_MS = 2 * 60 * 1000;
const imapPool = new Map<string, PoolEntry>();

function getPoolKey(config: ImapConfig): string {
  return `${config.email}|${config.host}|${config.port}|${config.secure}`;
}

export async function withImapClient<T>(
  config: ImapConfig,
  operation: (client: ImapFlow) => Promise<T>
): Promise<T> {
  const key = getPoolKey(config);
  let entry = imapPool.get(key);

  if (!entry) {
    entry = { client: createImapClient(config), queue: Promise.resolve() };
    imapPool.set(key, entry);
  }

  const run = entry.queue.then(async () => {
    if (entry!.idleTimer) {
      clearTimeout(entry!.idleTimer);
      entry!.idleTimer = undefined;
    }

    try {
      if (!entry!.client.usable) {
        entry!.client = createImapClient(config);
        await entry!.client.connect();
      } else {
        await entry!.client.noop();
      }
    } catch {
      try {
        await entry!.client.logout();
      } catch {
        // Ignore cleanup failures; a fresh connection is created below.
      }
      entry!.client = createImapClient(config);
      await entry!.client.connect();
    }

    const result = await operation(entry!.client);
    entry!.idleTimer = setTimeout(() => {
      const current = imapPool.get(key);
      if (current !== entry) return;
      imapPool.delete(key);
      current.client.logout().catch(() => undefined);
    }, IMAP_IDLE_TTL_MS);

    return result;
  });

  entry.queue = run.then(() => undefined, () => undefined);
  return run;
}

// ─── Service Functions ────────────────────────────────────────────────────────

const SPECIAL_FOLDER_ALIASES: Record<string, string> = {
  Sent: '\\Sent',
  Drafts: '\\Drafts',
  Trash: '\\Trash',
  Spam: '\\Junk',
};

const COMMON_FOLDER_NAMES: Record<string, string[]> = {
  Sent: ['sent', 'sent mail', 'enviados'],
  Drafts: ['drafts', 'rascunhos'],
  Trash: ['trash', 'lixeira', 'deleted messages', 'deleted items'],
  Spam: ['spam', 'junk', 'bulk mail', 'lixo eletrônico', 'lixo eletronico'],
};

/**
 * Lists all mailbox folders (Inbox, Sent, Drafts, Trash, etc.)
 */
export async function listFolders(config: ImapConfig): Promise<MailboxFolder[]> {
  return withImapClient(config, async (client) => {
    const tree = await client.listTree();
    const folders: MailboxFolder[] = [];

    function traverse(children: ListTreeResponse[] = []) {
      for (const folder of children) {
        folders.push({
          name: folder.name ?? folder.path ?? '',
          path: folder.path ?? '',
          delimiter: folder.delimiter ?? '/',
          flags: [...(folder.flags ?? [])],
          specialUse: folder.specialUse,
        });
        if (folder.folders?.length) traverse(folder.folders);
      }
    }

    traverse(tree.folders);
    return folders;
  });
}

/**
 * Lists messages in a folder with pagination.
 */
export async function listMessages(
  config: ImapConfig,
  folder: string,
  page: number,
  limit: number
): Promise<{ messages: MailListItem[]; total: number }> {
  return withImapClient(config, async (client) => {
    const resolvedFolder = await resolveMailboxPath(client, folder);
    const mailbox = await client.mailboxOpen(resolvedFolder, { readOnly: true });
    const allMessageIdsResult = folder === 'Starred'
      ? await client.search({ flagged: true }, { uid: false })
      : null;
    const allMessageIds = Array.isArray(allMessageIdsResult) ? allMessageIdsResult : null;
    const total = allMessageIds ? allMessageIds.length : mailbox.exists;

    if (total === 0) {
      return { messages: [], total: 0 };
    }

    const range = getPageRange(total, page, limit, allMessageIds ?? undefined);

    const messages: MailListItem[] = [];

    for await (const msg of client.fetch(range, {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: true,
    })) {
      const isRead = msg.flags?.has('\\Seen') ?? false;
      const isStarred = msg.flags?.has('\\Flagged') ?? false;

      const from = msg.envelope?.from?.[0];
      const fromAddress: MailAddress = {
        name: from?.name ?? undefined,
        address: from?.address ?? '',
      };

      const toList = (msg.envelope?.to ?? []).map((a) => ({
        name: a.name ?? undefined,
        address: a.address ?? '',
      }));

      const hasAttachments = hasAttachment(msg);

      messages.push({
        uid: msg.uid,
        messageId: msg.envelope?.messageId ?? '',
        subject: msg.envelope?.subject ?? '(no subject)',
        from: fromAddress,
        to: toList,
        date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
        isRead,
        isStarred,
        hasAttachments,
        preview: '',
      });
    }

    // Return most recent first
    return { messages: messages.reverse(), total };
  });
}

/**
 * Fetches a single message by UID with full body and attachments.
 */
export async function getMessage(
  config: ImapConfig,
  folder: string,
  uid: number
): Promise<MailMessage | null> {
  return withImapClient(config, async (client) => {
    const resolvedFolder = await resolveMailboxPath(client, folder);
    await client.mailboxOpen(resolvedFolder);

    const msg = await client.fetchOne(uid.toString(), {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: true,
    }, { uid: true });

    if (!msg) return null;

    const preferredBodyPart = findPreferredBodyPart(msg.bodyStructure);
    let bodyHtml: string | undefined;
    let bodyText: string | undefined;

    if (preferredBodyPart?.part) {
      const { content } = await client.download(uid.toString(), preferredBodyPart.part, {
        uid: true,
        maxBytes: 2 * 1024 * 1024,
      });
      const body = await streamToString(content);

      if (preferredBodyPart.type.toLowerCase() === 'text/html') {
        bodyHtml = sanitizeEmailHtml(body);
        bodyText = htmlToPlainText(bodyHtml);
      } else {
        bodyText = body;
      }
    } else {
      const { content } = await client.download(uid.toString(), undefined, {
        uid: true,
        maxBytes: 2 * 1024 * 1024,
      });
      const rawEmail = await streamToBuffer(content);
      const parsed = await simpleParser(rawEmail);
      bodyHtml = parsed.html ? sanitizeEmailHtml(parsed.html) : undefined;
      bodyText = parsed.text ?? (bodyHtml ? htmlToPlainText(bodyHtml) : undefined);
    }

    await client.messageFlagsAdd(uid.toString(), ['\\Seen'], { uid: true });

    const attachments = listAttachments(msg.bodyStructure);

    const from = msg.envelope?.from?.[0];

    return {
      uid,
      messageId: msg.envelope?.messageId ?? '',
      subject: msg.envelope?.subject ?? '(no subject)',
      from: { name: from?.name, address: from?.address ?? '' },
      to: (msg.envelope?.to ?? []).map(a => ({
        name: a.name ?? undefined,
        address: a.address ?? '',
      })),
      cc: msg.envelope?.cc?.map((a) => ({ name: a.name ?? undefined, address: a.address ?? '' })),
      date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
      isRead: true,
      isStarred: msg.flags?.has('\\Flagged') ?? false,
      hasAttachments: attachments.length > 0,
      preview: (bodyText ?? '').slice(0, 150),
      bodyHtml,
      bodyText,
      attachments,
      inReplyTo: msg.envelope?.inReplyTo,
    };
  });
}

/**
 * Updates flags on a message (read, starred, etc.)
 */
export async function updateMessageFlags(
  config: ImapConfig,
  folder: string,
  uid: number,
  action: 'add' | 'remove',
  flags: string[]
): Promise<void> {
  await withImapClient(config, async (client) => {
    const resolvedFolder = await resolveMailboxPath(client, folder);
    await client.mailboxOpen(resolvedFolder);
    if (action === 'add') {
      await client.messageFlagsAdd(uid.toString(), flags, { uid: true });
    } else {
      await client.messageFlagsRemove(uid.toString(), flags, { uid: true });
    }
  });
}

/**
 * Moves a message to Trash.
 */
export async function deleteMessage(
  config: ImapConfig,
  folder: string,
  uid: number,
  trashFolder = 'Trash'
): Promise<void> {
  await withImapClient(config, async (client) => {
    const resolvedFolder = await resolveMailboxPath(client, folder);
    const resolvedTrashFolder = await resolveMailboxPath(client, trashFolder);
    await client.mailboxOpen(resolvedFolder);
    await client.messageMove(uid.toString(), resolvedTrashFolder, { uid: true });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export async function resolveMailboxPath(client: ImapFlow, folder: string): Promise<string> {
  if (folder === 'Starred') return 'INBOX';
  if (folder === 'INBOX') return 'INBOX';

  const specialUse = SPECIAL_FOLDER_ALIASES[folder] ?? SPECIAL_FOLDER_ALIASES[folder.replace(/^INBOX[./]/, '')];
  if (!specialUse) return folder;

  const tree = await client.listTree();
  const match = findMailboxBySpecialUse(tree.folders, specialUse);
  const nameMatch = findMailboxByCommonName(tree.folders, COMMON_FOLDER_NAMES[folder] ?? []);
  return match?.path ?? nameMatch?.path ?? folder;
}

function findMailboxBySpecialUse(folders: ListTreeResponse[] = [], specialUse: string): ListTreeResponse | null {
  for (const folder of folders) {
    if (folder.specialUse === specialUse || folder.flags?.has(specialUse)) {
      return folder;
    }

    if (folder.folders?.length) {
      const childMatch = findMailboxBySpecialUse(folder.folders, specialUse);
      if (childMatch) return childMatch;
    }
  }

  return null;
}

function findMailboxByCommonName(folders: ListTreeResponse[] = [], names: string[]): ListTreeResponse | null {
  for (const folder of folders) {
    const normalizedName = (folder.name ?? folder.path ?? '').toLowerCase();
    if (names.includes(normalizedName)) {
      return folder;
    }

    if (folder.folders?.length) {
      const childMatch = findMailboxByCommonName(folder.folders, names);
      if (childMatch) return childMatch;
    }
  }

  return null;
}

function getPageRange(total: number, page: number, limit: number, messageIds?: number[]): string | number[] {
  const end = Math.max(1, total - (page - 1) * limit);
  const start = Math.max(1, end - limit + 1);

  if (!messageIds) {
    return `${start}:${end}`;
  }

  return messageIds.slice(start - 1, end);
}

export function hasAttachment(msg: FetchMessageObject): boolean {
  const structure = msg.bodyStructure;
  if (!structure) return false;

  function checkPart(part: MessageStructureObject): boolean {
    const disposition = part.disposition?.toLowerCase();
    const type = part.type?.toLowerCase() ?? '';
    if (disposition === 'attachment' || disposition === 'inline' || !!part.id || type.startsWith('image/')) return true;
    if (part.childNodes?.length) {
      return part.childNodes.some(checkPart);
    }
    return false;
  }

  return checkPart(structure);
}

export function findPreferredBodyPart(structure?: MessageStructureObject): MessageStructureObject | null {
  if (!structure) return null;

  const parts = flattenStructure(structure).filter((part) => {
    const type = part.type?.toLowerCase();
    const disposition = part.disposition?.toLowerCase();
    return (type === 'text/html' || type === 'text/plain') && disposition !== 'attachment';
  });

  return parts.find((part) => part.type?.toLowerCase() === 'text/html') ?? parts[0] ?? null;
}

export function listAttachments(structure?: MessageStructureObject): MailMessage['attachments'] {
  if (!structure) return [];

  return flattenStructure(structure)
    .filter((part) => {
      const disposition = part.disposition?.toLowerCase();
      const type = part.type?.toLowerCase() ?? '';
      return !!part.part && (disposition === 'attachment' || disposition === 'inline' || !!part.id || type.startsWith('image/'));
    })
    .map((part, index) => ({
      id: part.part ?? `att-${index}`,
      filename: fixMojibake(
        part.dispositionParameters?.filename ??
        part.parameters?.name ??
        `attachment-${index + 1}`
      ),
      mimeType: part.type,
      size: part.size ?? 0,
      contentId: part.id,
      disposition: part.disposition,
      isInline: part.disposition?.toLowerCase() === 'inline' || !!part.id,
    }));
}

function fixMojibake(value: string): string {
  if (!/[ÃÂâ]/.test(value)) return value;
  return Buffer.from(value, 'latin1').toString('utf8');
}

export function normalizeAttachmentFilename(value: string): string {
  return fixMojibake(value);
}

export function flattenStructure(structure: MessageStructureObject): MessageStructureObject[] {
  const children = structure.childNodes?.flatMap(flattenStructure) ?? [];
  return [structure, ...children];
}

export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return (await streamToBuffer(stream)).toString('utf8');
}
