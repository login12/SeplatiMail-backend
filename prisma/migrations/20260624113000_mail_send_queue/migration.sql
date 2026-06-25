CREATE TYPE "MailSendStatus" AS ENUM ('QUEUED', 'SENDING', 'APPENDING', 'SENT', 'FAILED', 'APPEND_FAILED');

CREATE TABLE "mail_send_jobs" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "status" "MailSendStatus" NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB NOT NULL,
    "message_id" TEXT,
    "raw_message" BYTEA,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_send_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mail_send_jobs_account_id_status_created_at_idx" ON "mail_send_jobs"("account_id", "status", "created_at");

ALTER TABLE "mail_send_jobs" ADD CONSTRAINT "mail_send_jobs_account_id_fkey"
FOREIGN KEY ("account_id") REFERENCES "mail_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
