import { MailBodyState, MailSyncStatus, MoreMessages, Prisma, type MailAccount, type MailFolder } from '@prisma/client';
import type { FetchMessageObject, ImapFlow } from 'imapflow';
import { prisma } from '@/config/database';
import { logger } from '@/utils/logger';
import { htmlToPlainText, sanitizeEmailHtml } from '@/utils/sanitize';
import * as accountService from '@/services/account.service';
import {
  findPreferredBodyPart,
  flattenStructure,
  hasAttachment,
  listAttachments,
  normalizeAttachmentFilename,
  resolveMailboxPath,
  streamToBuffer,
  streamToString,
  withImapClient,
  type ImapConfig,
} from '@/services/imap.service';
import type { MailAddress, MailListItem, MailMessage } from '@/types';

const DEFAULT_VISIBLE_LIMIT = 40;
const STALE_SYNC_MS = 30 * 1000;
const MAX_BODY_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_DOWNLOAD_BYTES = 32 * 1024;
const MAX_PREVIEW_LENGTH = 180;

const syncLocks = new Map<string, Promise<void>>();

type AccountContext = {
  account: MailAccount;
  config: ImapConfig;
};

export async function listFolders(userId: string) {
  const { account, config } = await getAccountContext(userId);

  const folders = await withImapClient(config, async (client) => {
    const tree = await client.listTree();
    const flattened: Array<{
      name: string;
      path: string;
      delimiter: string;
      flags: string[];
      specialUse?: string;
    }> = [];

    function traverse(children = tree.folders ?? []) {
      for (const folder of children) {
        flattened.push({
          name: folder.name ?? folder.path ?? '',
          path: folder.path ?? '',
          delimiter: folder.delimiter ?? '/',
          flags: [...(folder.flags ?? [])],
          specialUse: folder.specialUse,
        });
        if (folder.folders?.length) traverse(folder.folders);
      }
    }

    traverse();
    return flattened;
  });

  await prisma.$transaction(
    folders.map((folder) =>
      prisma.mailFolder.upsert({
        where: { accountId_path: { accountId: account.id, path: folder.path } },
        create: {
          accountId: account.id,
          path: folder.path,
          name: folder.name,
          delimiter: folder.delimiter,
          flags: folder.flags,
          specialUse: folder.specialUse,
          visibleLimit: DEFAULT_VISIBLE_LIMIT,
        },
        update: {
          name: folder.name,
          delimiter: folder.delimiter,
          flags: folder.flags,
          specialUse: folder.specialUse,
        },
      })
    )
  );

  return folders;
}

export async function listMessages(
  userId: string,
  folder: string,
  page: number,
  limit: number
): Promise<{ messages: MailListItem[]; total: number }> {
  const { account, config } = await getAccountContext(userId);

  if (folder === 'Starred') {
    await ensureFolderSynced(account, config, 'INBOX', Math.max(page * limit, DEFAULT_VISIBLE_LIMIT));
    return listStarredFromCache(account.id, page, limit);
  }

  const syncedFolder = await ensureFolderSynced(account, config, folder, Math.max(page * limit, DEFAULT_VISIBLE_LIMIT));
  triggerStaleSync(account, config, syncedFolder);

  const where = {
    accountId: account.id,
    folderId: syncedFolder.id,
    ...(syncedFolder.uidValidity ? { uidValidity: syncedFolder.uidValidity } : {}),
    isDeleted: false,
    isStale: false,
  };

  const [total, messages] = await prisma.$transaction([
    prisma.mailMessageCache.count({ where }),
    prisma.mailMessageCache.findMany({
      where,
      include: { folder: { select: { path: true } } },
      orderBy: [{ date: 'desc' }, { uid: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  if (messages.some((message) => !message.preview)) {
    await syncCachedMessagePreviews(account, config, syncedFolder, messages.map((message) => message.uid));
    const hydratedMessages = await prisma.mailMessageCache.findMany({
      where,
      include: { folder: { select: { path: true } } },
      orderBy: [{ date: 'desc' }, { uid: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    });

    return { total, messages: hydratedMessages.map(toMailListItem) };
  }

  return { total, messages: messages.map(toMailListItem) };
}

export async function getMessage(userId: string, folder: string, uid: number): Promise<MailMessage | null> {
  const { account, config } = await getAccountContext(userId);
  const sourceFolder = folder === 'Starred'
    ? await findStarredMessageFolder(account.id, uid)
    : null;
  const syncedFolder = sourceFolder
    ? await ensureFolderSynced(account, config, sourceFolder.path, DEFAULT_VISIBLE_LIMIT)
    : await ensureFolderSynced(account, config, folder, DEFAULT_VISIBLE_LIMIT);
  const uidBigInt = BigInt(uid);

  const cached = await prisma.mailMessageCache.findFirst({
    where: {
      accountId: account.id,
      folderId: syncedFolder.id,
      uid: uidBigInt,
      ...(syncedFolder.uidValidity ? { uidValidity: syncedFolder.uidValidity } : {}),
      isDeleted: false,
      isStale: false,
    },
    include: { folder: { select: { path: true } } },
  });

  if (cached?.bodyState === MailBodyState.FULL || cached?.bodyState === MailBodyState.PARTIAL) {
    await markRemoteRead(config, syncedFolder.path, uidBigInt);
    await markCachedRead(account.id, syncedFolder.id, uidBigInt);
    return toMailMessage({ ...cached, isRead: true }, true);
  }

  return downloadAndCacheMessage(account, config, syncedFolder, uidBigInt);
}

export async function updateMessageFlags(
  userId: string,
  folder: string,
  uid: number,
  action: 'add' | 'remove',
  flags: string[]
): Promise<void> {
  const { account, config } = await getAccountContext(userId);
  const syncedFolder = await ensureFolderSynced(account, config, folder, DEFAULT_VISIBLE_LIMIT);
  const uidBigInt = BigInt(uid);

  await withImapClient(config, async (client) => {
    const resolvedFolder = await resolveMailboxPath(client, folder);
    await client.mailboxOpen(resolvedFolder);
    if (action === 'add') {
      await client.messageFlagsAdd(uid.toString(), flags, { uid: true });
    } else {
      await client.messageFlagsRemove(uid.toString(), flags, { uid: true });
    }
  });

  await prisma.mailMessageCache.updateMany({
    where: {
      accountId: account.id,
      folderId: syncedFolder.id,
      uid: uidBigInt,
      ...(syncedFolder.uidValidity ? { uidValidity: syncedFolder.uidValidity } : {}),
      isStale: false,
    },
    data: flagPatch(action, flags),
  });
}

export async function deleteMessage(
  userId: string,
  folder: string,
  uid: number,
  trashFolder = 'Trash'
): Promise<void> {
  const { account, config } = await getAccountContext(userId);
  const syncedFolder = await ensureFolderSynced(account, config, folder, DEFAULT_VISIBLE_LIMIT);

  await withImapClient(config, async (client) => {
    const resolvedFolder = await resolveMailboxPath(client, folder);
    const resolvedTrashFolder = await resolveMailboxPath(client, trashFolder);
    await client.mailboxOpen(resolvedFolder);
    await client.messageMove(uid.toString(), resolvedTrashFolder, { uid: true });
  });

  await prisma.mailMessageCache.updateMany({
    where: {
      accountId: account.id,
      folderId: syncedFolder.id,
      uid: BigInt(uid),
      ...(syncedFolder.uidValidity ? { uidValidity: syncedFolder.uidValidity } : {}),
      isStale: false,
    },
    data: { isDeleted: true },
  });
}

export async function permanentlyDeleteMessages(userId: string, folder: string, uids: number[]): Promise<number> {
  if (uids.length === 0) return 0;

  const { account, config } = await getAccountContext(userId);
  const syncedFolder = await ensureFolderSynced(account, config, folder, DEFAULT_VISIBLE_LIMIT);
  const uidRange = uniqueNumbers(uids).join(',');

  await withImapClient(config, async (client) => {
    await client.mailboxOpen(syncedFolder.path);
    await client.messageDelete(uidRange, { uid: true });
  });

  await prisma.mailMessageCache.updateMany({
    where: {
      accountId: account.id,
      folderId: syncedFolder.id,
      uid: { in: uniqueNumbers(uids).map((uid) => BigInt(uid)) },
      ...(syncedFolder.uidValidity ? { uidValidity: syncedFolder.uidValidity } : {}),
      isStale: false,
    },
    data: { isDeleted: true },
  });

  return uids.length;
}

export async function emptyFolder(userId: string, folder: string): Promise<number> {
  const { account, config } = await getAccountContext(userId);
  const syncedFolder = await ensureFolderSynced(account, config, folder, DEFAULT_VISIBLE_LIMIT);
  let deletedCount = 0;

  await withImapClient(config, async (client) => {
    await client.mailboxOpen(syncedFolder.path);
    const result = await client.search({ all: true }, { uid: true });
    const uids = Array.isArray(result) ? result : [];
    deletedCount = uids.length;
    if (uids.length > 0) {
      await client.messageDelete(uids.join(','), { uid: true });
    }
  });

  if (deletedCount > 0) {
    await prisma.mailMessageCache.updateMany({
      where: {
        accountId: account.id,
        folderId: syncedFolder.id,
        ...(syncedFolder.uidValidity ? { uidValidity: syncedFolder.uidValidity } : {}),
        isStale: false,
      },
      data: { isDeleted: true },
    });
  }

  return deletedCount;
}

export async function moveMessages(userId: string, sourceFolder: string, destinationFolder: string, uids: number[]): Promise<number> {
  if (uids.length === 0) return 0;

  const { account, config } = await getAccountContext(userId);
  const syncedSourceFolder = await ensureFolderSynced(account, config, sourceFolder, DEFAULT_VISIBLE_LIMIT);
  const uidRange = uniqueNumbers(uids).join(',');

  await withImapClient(config, async (client) => {
    const destinationPath = await resolveMailboxPath(client, destinationFolder);
    await client.mailboxOpen(syncedSourceFolder.path);
    await client.messageMove(uidRange, destinationPath, { uid: true });
  });

  await prisma.mailMessageCache.updateMany({
    where: {
      accountId: account.id,
      folderId: syncedSourceFolder.id,
      uid: { in: uniqueNumbers(uids).map((uid) => BigInt(uid)) },
      ...(syncedSourceFolder.uidValidity ? { uidValidity: syncedSourceFolder.uidValidity } : {}),
      isStale: false,
    },
    data: { isDeleted: true },
  });

  return uids.length;
}

export async function downloadMessagePart(
  userId: string,
  folder: string,
  uid: number,
  partId: string
): Promise<{ content: Buffer; mimeType: string; filename: string } | null> {
  const { account, config } = await getAccountContext(userId);
  const syncedFolder = await ensureFolderSynced(account, config, folder, DEFAULT_VISIBLE_LIMIT);

  return withImapClient(config, async (client) => {
    await client.mailboxOpen(syncedFolder.path, { readOnly: true });
    const msg = await client.fetchOne(uid.toString(), { uid: true, bodyStructure: true }, { uid: true });
    if (!msg) return null;

    const part = msg.bodyStructure
      ? flattenStructure(msg.bodyStructure).find((candidate) => candidate.part === partId)
      : undefined;

    if (!part?.part) return null;

    const { content } = await client.download(uid.toString(), part.part, { uid: true });
    const filename = normalizeAttachmentFilename(
      part.dispositionParameters?.filename ?? part.parameters?.name ?? `attachment-${part.part}`
    );

    return {
      content: await streamToBuffer(content),
      mimeType: part.type || 'application/octet-stream',
      filename,
    };
  });
}

async function getAccountContext(userId: string): Promise<AccountContext> {
  const [account, config] = await Promise.all([
    prisma.mailAccount.findUnique({ where: { userId } }),
    accountService.getImapConfig(userId),
  ]);

  if (!account || !account.isActive) throw new Error('MAIL_ACCOUNT_NOT_FOUND');
  return { account, config };
}

async function ensureFolderSynced(
  account: MailAccount,
  config: ImapConfig,
  requestedFolder: string,
  visibleLimit: number
): Promise<MailFolder> {
  const cachedFolder = await findCachedFolder(account.id, requestedFolder);
  if (
    cachedFolder &&
    cachedFolder.visibleLimit >= visibleLimit &&
    cachedFolder.lastSyncedAt &&
    Date.now() - cachedFolder.lastSyncedAt.getTime() < STALE_SYNC_MS
  ) {
    return cachedFolder;
  }

  const cacheKey = `${account.id}:${requestedFolder}`;
  const existingLock = syncLocks.get(cacheKey);
  if (existingLock) {
    await existingLock;
    const folderAfterLock = await getCachedFolder(account.id, requestedFolder);
    if (folderAfterLock.visibleLimit >= visibleLimit) {
      return folderAfterLock;
    }
  }

  const lock = syncFolder(account, config, requestedFolder, visibleLimit)
    .catch((err) => {
      logger.error({ err, accountId: account.id, folder: requestedFolder, msg: 'Mail sync failed' });
      throw err;
    })
    .finally(() => {
      syncLocks.delete(cacheKey);
    });

  syncLocks.set(cacheKey, lock);
  await lock;
  return getCachedFolder(account.id, requestedFolder);
}

async function syncFolder(
  account: MailAccount,
  config: ImapConfig,
  requestedFolder: string,
  visibleLimit: number
): Promise<void> {
  await withImapClient(config, async (client) => {
    const resolvedFolder = await resolveMailboxPath(client, requestedFolder);
    const folder = await upsertFolder(account.id, resolvedFolder, requestedFolder, visibleLimit);

    await prisma.mailFolder.update({
      where: { id: folder.id },
      data: { syncStatus: MailSyncStatus.SYNCING, lastError: null, visibleLimit },
    });

    try {
      const mailbox = await client.mailboxOpen(resolvedFolder, { readOnly: true });
      const uidValidity = mailbox.uidValidity ?? BigInt(0);

      if (folder.uidValidity !== null && folder.uidValidity !== uidValidity) {
        await prisma.mailMessageCache.updateMany({
          where: { folderId: folder.id, isStale: false },
          data: { isStale: true, bodyState: MailBodyState.STALE },
        });
      }

      const visibleSequenceRange = getVisibleSequenceRange(mailbox.exists, visibleLimit);
      const highestKnownUid = folder.uidValidity === uidValidity ? folder.highestKnownUid : BigInt(0);

      const fetched = new Map<bigint, FetchMessageObject>();
      if (visibleSequenceRange) {
        await fetchMetadataIntoMap(client, visibleSequenceRange.value, false, fetched);
      }

      if (highestKnownUid > BigInt(0)) {
        const newUidResult = await client.search({ uid: `${highestKnownUid + BigInt(1)}:*` }, { uid: true });
        const newUids = Array.isArray(newUidResult)
          ? newUidResult.map((uid) => BigInt(uid)).filter((uid) => !fetched.has(uid))
          : [];
        await fetchMetadataIntoMap(client, newUids.map(Number), true, fetched);
      }

      const messages = [...fetched.values()];
      await prisma.$transaction(
        messages.map((message) => upsertMessage(account.id, folder.id, uidValidity, message))
      );
      await syncMissingPreviews(client, account.id, folder.id, uidValidity, messages);

      const maxFetchedUid = messages.reduce((max, message) => {
        const uid = BigInt(message.uid);
        return uid > max ? uid : max;
      }, highestKnownUid);

      await prisma.mailFolder.update({
        where: { id: folder.id },
        data: {
          uidValidity,
          highestKnownUid: maxFetchedUid,
          totalMessages: mailbox.exists,
          moreMessages: visibleSequenceRange?.start === 1 ? MoreMessages.FALSE : MoreMessages.TRUE,
          syncStatus: MailSyncStatus.IDLE,
          lastSyncedAt: new Date(),
          lastError: null,
        },
      });
    } catch (err) {
      await prisma.mailFolder.update({
        where: { id: folder.id },
        data: {
          syncStatus: MailSyncStatus.ERROR,
          lastError: err instanceof Error ? err.message : 'Unknown sync error',
        },
      });
      throw err;
    }
  });
}

async function syncMissingPreviews(
  client: ImapFlow,
  accountId: string,
  folderId: string,
  uidValidity: bigint,
  messages: FetchMessageObject[]
): Promise<void> {
  const candidates = messages.filter((message) => findPreferredBodyPart(message.bodyStructure)?.part);
  if (candidates.length === 0) return;

  const cached = await prisma.mailMessageCache.findMany({
    where: {
      accountId,
      folderId,
      uidValidity,
      uid: { in: candidates.map((message) => BigInt(message.uid)) },
      preview: '',
      isDeleted: false,
      isStale: false,
    },
    select: { uid: true },
  });
  const missingPreviewUids = new Set(cached.map((message) => message.uid.toString()));
  if (missingPreviewUids.size === 0) return;

  for (const message of candidates) {
    const uid = BigInt(message.uid);
    if (!missingPreviewUids.has(uid.toString())) continue;

    const preview = await downloadPreviewText(client, uid, message).catch((err) => {
      logger.debug({ err, uid: uid.toString(), msg: 'Failed to generate message preview' });
      return '';
    });

    if (!preview) continue;

    await prisma.mailMessageCache.updateMany({
      where: {
        accountId,
        folderId,
        uidValidity,
        uid,
        preview: '',
        isDeleted: false,
        isStale: false,
      },
      data: { preview },
    });
  }
}

async function syncCachedMessagePreviews(
  account: MailAccount,
  config: ImapConfig,
  folder: MailFolder,
  uids: bigint[]
): Promise<void> {
  const missingUidRows = await prisma.mailMessageCache.findMany({
    where: {
      accountId: account.id,
      folderId: folder.id,
      uidValidity: folder.uidValidity ?? BigInt(0),
      uid: { in: uids },
      preview: '',
      isDeleted: false,
      isStale: false,
    },
    select: { uid: true },
  });
  if (missingUidRows.length === 0) return;

  const missingUids = missingUidRows.map((row) => Number(row.uid));
  await withImapClient(config, async (client) => {
    await client.mailboxOpen(folder.path, { readOnly: true });
    const fetched = new Map<bigint, FetchMessageObject>();
    await fetchMetadataIntoMap(client, missingUids, true, fetched);
    await syncMissingPreviews(client, account.id, folder.id, folder.uidValidity ?? BigInt(0), [...fetched.values()]);
  });
}

async function downloadPreviewText(
  client: ImapFlow,
  uid: bigint,
  message: FetchMessageObject
): Promise<string> {
  const preferredBodyPart = findPreferredBodyPart(message.bodyStructure);
  if (!preferredBodyPart?.part) return '';

  const { content } = await client.download(uid.toString(), preferredBodyPart.part, {
    uid: true,
    maxBytes: MAX_PREVIEW_DOWNLOAD_BYTES,
    chunkSize: MAX_PREVIEW_DOWNLOAD_BYTES,
  });
  if (!content) return '';

  const body = await streamToString(content);
  const text = preferredBodyPart.type.toLowerCase() === 'text/html'
    ? htmlToPlainText(sanitizeEmailHtml(body))
    : htmlToPlainText(body);

  return normalizePreviewText(text);
}

async function fetchMetadataIntoMap(
  client: ImapFlow,
  range: string | number[],
  uidRange: boolean,
  output: Map<bigint, FetchMessageObject>
) {
  if (Array.isArray(range) && range.length === 0) return;

  for await (const message of client.fetch(
    range,
    {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: true,
      internalDate: true,
      size: true,
    },
    uidRange ? { uid: true } : undefined
  )) {
    output.set(BigInt(message.uid), message);
  }
}

function upsertMessage(accountId: string, folderId: string, uidValidity: bigint, msg: FetchMessageObject) {
  const flags = [...(msg.flags ?? [])];
  const from = msg.envelope?.from?.[0];
  const fromAddress: MailAddress = { name: from?.name ?? undefined, address: from?.address ?? '' };
  const to = (msg.envelope?.to ?? []).map((address) => ({
    name: address.name ?? undefined,
    address: address.address ?? '',
  }));
  const cc = (msg.envelope?.cc ?? []).map((address) => ({
    name: address.name ?? undefined,
    address: address.address ?? '',
  }));
  const attachments = listAttachments(msg.bodyStructure);

  return prisma.mailMessageCache.upsert({
    where: { folderId_uid_uidValidity: { folderId, uid: BigInt(msg.uid), uidValidity } },
    create: {
      accountId,
      folderId,
      uid: BigInt(msg.uid),
      uidValidity,
      messageId: msg.envelope?.messageId,
      subject: msg.envelope?.subject ?? '(no subject)',
      from: toJson(fromAddress),
      to: toJson(to),
      cc: toJson(cc),
      date: msg.envelope?.date ?? new Date(),
      internalDate: normalizeDate(msg.internalDate),
      size: msg.size,
      flags,
      isRead: msg.flags?.has('\\Seen') ?? false,
      isStarred: msg.flags?.has('\\Flagged') ?? false,
      hasAttachments: hasAttachment(msg),
      attachmentCount: attachments.length,
      bodyState: MailBodyState.ENVELOPE,
      attachments: toJson(attachments),
      inReplyTo: msg.envelope?.inReplyTo,
      references: [],
      isDeleted: msg.flags?.has('\\Deleted') ?? false,
      isStale: false,
    },
    update: {
      messageId: msg.envelope?.messageId,
      subject: msg.envelope?.subject ?? '(no subject)',
      from: toJson(fromAddress),
      to: toJson(to),
      cc: toJson(cc),
      date: msg.envelope?.date ?? new Date(),
      internalDate: normalizeDate(msg.internalDate),
      size: msg.size,
      flags,
      isRead: msg.flags?.has('\\Seen') ?? false,
      isStarred: msg.flags?.has('\\Flagged') ?? false,
      hasAttachments: hasAttachment(msg),
      attachmentCount: attachments.length,
      attachments: toJson(attachments),
      inReplyTo: msg.envelope?.inReplyTo,
      isDeleted: msg.flags?.has('\\Deleted') ?? false,
      isStale: false,
    },
  });
}

async function downloadAndCacheMessage(
  account: MailAccount,
  config: ImapConfig,
  folder: MailFolder,
  uid: bigint
): Promise<MailMessage | null> {
  return withImapClient(config, async (client) => {
    await client.mailboxOpen(folder.path);

    const msg = await client.fetchOne(uid.toString(), {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: true,
    }, { uid: true });

    if (!msg) return null;

    const uidValidity = folder.uidValidity ?? BigInt(0);
    await upsertMessage(account.id, folder.id, uidValidity, msg);

    const preferredBodyPart = findPreferredBodyPart(msg.bodyStructure);
    let bodyHtml: string | undefined;
    let bodyText: string | undefined;
    let bodyState: MailBodyState = MailBodyState.PARTIAL;

    if (preferredBodyPart?.part) {
      const { content } = await client.download(uid.toString(), preferredBodyPart.part, {
        uid: true,
        maxBytes: MAX_BODY_DOWNLOAD_BYTES,
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
        maxBytes: MAX_BODY_DOWNLOAD_BYTES,
      });
      const rawEmail = await streamToBuffer(content);
      bodyState = rawEmail.length < MAX_BODY_DOWNLOAD_BYTES ? MailBodyState.FULL : MailBodyState.PARTIAL;
      const { simpleParser } = await import('mailparser');
      const parsed = await simpleParser(rawEmail);
      bodyHtml = parsed.html ? sanitizeEmailHtml(parsed.html) : undefined;
      bodyText = parsed.text ?? (bodyHtml ? htmlToPlainText(bodyHtml) : undefined);
    }

    await client.messageFlagsAdd(uid.toString(), ['\\Seen'], { uid: true });

    const updated = await prisma.mailMessageCache.update({
      where: { folderId_uid_uidValidity: { folderId: folder.id, uid, uidValidity } },
      data: {
        bodyHtml,
        bodyText,
        preview: (bodyText ?? htmlToPlainText(bodyHtml ?? '')).slice(0, 150),
        bodyState,
        isRead: true,
        flags: [...(msg.flags ?? []), '\\Seen'].filter(unique),
      },
    });

    return { ...toMailMessage(updated, true), folderPath: folder.path };
  });
}

async function upsertFolder(
  accountId: string,
  path: string,
  requestedFolder: string,
  visibleLimit: number
): Promise<MailFolder> {
  const existing = await prisma.mailFolder.findUnique({
    where: { accountId_path: { accountId, path } },
  });

  if (!existing) {
    return prisma.mailFolder.create({
      data: {
        accountId,
        path,
        name: requestedFolder,
        visibleLimit,
      },
    });
  }

  return prisma.mailFolder.update({
    where: { id: existing.id },
    data: {
      name: existing.name || requestedFolder,
      visibleLimit: Math.max(existing.visibleLimit, visibleLimit),
    },
  });
}

async function findCachedFolder(accountId: string, requestedFolder: string): Promise<MailFolder | null> {
  return prisma.mailFolder.findFirst({
    where: requestedFolder === 'INBOX'
      ? { accountId, path: 'INBOX' }
      : { accountId, OR: [{ path: requestedFolder }, { name: requestedFolder }] },
  });
}

async function getCachedFolder(accountId: string, requestedFolder: string): Promise<MailFolder> {
  const folder = await findCachedFolder(accountId, requestedFolder);

  if (!folder) throw new Error('MAIL_FOLDER_NOT_FOUND');
  return folder;
}

async function listStarredFromCache(accountId: string, page: number, limit: number) {
  const where = { accountId, isStarred: true, isDeleted: false, isStale: false };
  const [total, messages] = await prisma.$transaction([
    prisma.mailMessageCache.count({ where }),
    prisma.mailMessageCache.findMany({
      where,
      include: { folder: { select: { path: true } } },
      orderBy: [{ date: 'desc' }, { uid: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return { total, messages: messages.map(toMailListItem) };
}

async function findStarredMessageFolder(accountId: string, uid: number): Promise<MailFolder | null> {
  const message = await prisma.mailMessageCache.findFirst({
    where: {
      accountId,
      uid: BigInt(uid),
      isStarred: true,
      isDeleted: false,
      isStale: false,
    },
    include: { folder: true },
    orderBy: [{ date: 'desc' }],
  });

  return message?.folder ?? null;
}

function triggerStaleSync(account: MailAccount, config: ImapConfig, folder: MailFolder): void {
  if (!folder.lastSyncedAt) return;
  if (Date.now() - folder.lastSyncedAt.getTime() < STALE_SYNC_MS) return;

  const key = `${account.id}:${folder.path}:background`;
  if (syncLocks.has(key)) return;

  const lock = syncFolder(account, config, folder.path, folder.visibleLimit)
    .catch((err) => logger.warn({ err, accountId: account.id, folder: folder.path, msg: 'Background sync failed' }))
    .finally(() => syncLocks.delete(key));

  syncLocks.set(key, lock);
}

function getVisibleSequenceRange(total: number, visibleLimit: number): { start: number; end: number; value: string } | null {
  if (total <= 0) return null;

  const start = visibleLimit > 0 ? Math.max(1, total - visibleLimit + 1) : 1;
  return { start, end: total, value: `${start}:${total}` };
}

function normalizeDate(value: Date | string | undefined): Date | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value : new Date(value);
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function toMailListItem(message: {
  uid: bigint;
  folder?: { path: string };
  messageId: string | null;
  subject: string;
  from: unknown;
  to: unknown;
  date: Date;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  preview: string;
  attachments?: unknown;
}): MailListItem {
  return {
    uid: Number(message.uid),
    folderPath: message.folder?.path,
    messageId: message.messageId ?? '',
    subject: message.subject,
    from: toAddress(message.from),
    to: toAddressList(message.to),
    date: message.date.toISOString(),
    isRead: message.isRead,
    isStarred: message.isStarred,
    hasAttachments: message.hasAttachments,
    preview: message.preview,
    attachments: Array.isArray(message.attachments) ? message.attachments as MailMessage['attachments'] : undefined,
  };
}

function toMailMessage(message: {
  uid: bigint;
  folder?: { path: string };
  messageId: string | null;
  subject: string;
  from: unknown;
  to: unknown;
  date: Date;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  preview: string;
  cc: unknown;
  bodyHtml: string | null;
  bodyText: string | null;
  attachments: unknown;
  inReplyTo: string | null;
  references: string[];
}, forceRead = false): MailMessage {
  const listItem = toMailListItem({ ...message, isRead: forceRead ? true : message.isRead });

  return {
    ...listItem,
    cc: toAddressList(message.cc),
    bodyHtml: message.bodyHtml ?? undefined,
    bodyText: message.bodyText ?? undefined,
    attachments: Array.isArray(message.attachments) ? message.attachments as MailMessage['attachments'] : [],
    inReplyTo: message.inReplyTo ?? undefined,
    references: message.references,
  };
}

function normalizePreviewText(text: string): string {
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .replace(/^>.*$/gm, ' ')
    .replace(/^\s*[-_]{3,}\s*$/gm, ' ')
    .replace(/https?:\/\/\S+/gi, '...')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.length > MAX_PREVIEW_LENGTH
    ? `${normalized.slice(0, MAX_PREVIEW_LENGTH - 1).trimEnd()}...`
    : normalized;
}

function toAddress(value: unknown): MailAddress {
  if (value && typeof value === 'object' && 'address' in value) {
    const address = value as MailAddress;
    return { name: address.name, address: address.address ?? '' };
  }

  return { address: '' };
}

function toAddressList(value: unknown): MailAddress[] {
  return Array.isArray(value) ? value.map(toAddress) : [];
}

function flagPatch(action: 'add' | 'remove', flags: string[]) {
  const isReadChange = flags.includes('\\Seen');
  const isStarredChange = flags.includes('\\Flagged');

  return {
    ...(isReadChange ? { isRead: action === 'add' } : {}),
    ...(isStarredChange ? { isStarred: action === 'add' } : {}),
  } satisfies Record<string, unknown>;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
}

async function markCachedRead(accountId: string, folderId: string, uid: bigint): Promise<void> {
  await prisma.mailMessageCache.updateMany({
    where: { accountId, folderId, uid, isStale: false, isRead: false },
    data: { isRead: true },
  });
}

async function markRemoteRead(config: ImapConfig, folderPath: string, uid: bigint): Promise<void> {
  await withImapClient(config, async (client) => {
    await client.mailboxOpen(folderPath);
    await client.messageFlagsAdd(uid.toString(), ['\\Seen'], { uid: true });
  });
}

function unique(value: string, index: number, list: string[]): boolean {
  return list.indexOf(value) === index;
}
