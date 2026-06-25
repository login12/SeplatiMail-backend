-- CreateEnum
CREATE TYPE "MoreMessages" AS ENUM ('UNKNOWN', 'TRUE', 'FALSE');

-- CreateEnum
CREATE TYPE "MailBodyState" AS ENUM ('NONE', 'ENVELOPE', 'PARTIAL', 'FULL', 'STALE');

-- CreateEnum
CREATE TYPE "MailSyncStatus" AS ENUM ('IDLE', 'SYNCING', 'ERROR');

-- CreateTable
CREATE TABLE "mail_folders" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "delimiter" TEXT NOT NULL DEFAULT '/',
    "flags" JSONB,
    "special_use" TEXT,
    "uid_validity" BIGINT,
    "highest_known_uid" BIGINT NOT NULL DEFAULT 0,
    "visible_limit" INTEGER NOT NULL DEFAULT 40,
    "total_messages" INTEGER NOT NULL DEFAULT 0,
    "more_messages" "MoreMessages" NOT NULL DEFAULT 'UNKNOWN',
    "sync_status" "MailSyncStatus" NOT NULL DEFAULT 'IDLE',
    "last_synced_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_message_cache" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "folder_id" TEXT NOT NULL,
    "uid" BIGINT NOT NULL,
    "uid_validity" BIGINT NOT NULL,
    "message_id" TEXT,
    "subject" TEXT NOT NULL DEFAULT '(no subject)',
    "from" JSONB NOT NULL,
    "to" JSONB NOT NULL,
    "cc" JSONB,
    "date" TIMESTAMP(3) NOT NULL,
    "internal_date" TIMESTAMP(3),
    "size" INTEGER,
    "flags" TEXT[],
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "is_starred" BOOLEAN NOT NULL DEFAULT false,
    "has_attachments" BOOLEAN NOT NULL DEFAULT false,
    "attachment_count" INTEGER NOT NULL DEFAULT 0,
    "preview" TEXT NOT NULL DEFAULT '',
    "body_state" "MailBodyState" NOT NULL DEFAULT 'NONE',
    "body_html" TEXT,
    "body_text" TEXT,
    "attachments" JSONB,
    "in_reply_to" TEXT,
    "references" TEXT[],
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "is_stale" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_message_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mail_folders_account_id_path_key" ON "mail_folders"("account_id", "path");

-- CreateIndex
CREATE INDEX "mail_folders_account_id_special_use_idx" ON "mail_folders"("account_id", "special_use");

-- CreateIndex
CREATE UNIQUE INDEX "mail_message_cache_folder_id_uid_uid_validity_key" ON "mail_message_cache"("folder_id", "uid", "uid_validity");

-- CreateIndex
CREATE INDEX "mail_message_cache_account_id_folder_id_date_idx" ON "mail_message_cache"("account_id", "folder_id", "date");

-- CreateIndex
CREATE INDEX "mail_message_cache_account_id_is_starred_date_idx" ON "mail_message_cache"("account_id", "is_starred", "date");

-- CreateIndex
CREATE INDEX "mail_message_cache_folder_id_is_deleted_is_stale_date_idx" ON "mail_message_cache"("folder_id", "is_deleted", "is_stale", "date");

-- AddForeignKey
ALTER TABLE "mail_folders" ADD CONSTRAINT "mail_folders_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "mail_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_message_cache" ADD CONSTRAINT "mail_message_cache_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "mail_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_message_cache" ADD CONSTRAINT "mail_message_cache_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "mail_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
