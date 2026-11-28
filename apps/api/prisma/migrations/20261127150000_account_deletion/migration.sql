-- P2-10 (ADR-0025): data export and account deletion.
-- Additive only: three new security event types, one new single-use token purpose and an index on
-- users.deleted_at for the purge job. No data is changed. Rollback before real data exists: drop
-- the index (enum values cannot be removed from PostgreSQL enums; they are harmless unused).

-- AlterEnum
ALTER TYPE "security_event_type" ADD VALUE 'data_exported';
ALTER TYPE "security_event_type" ADD VALUE 'account_deletion_requested';
ALTER TYPE "security_event_type" ADD VALUE 'account_restored';

-- AlterEnum
ALTER TYPE "user_token_purpose" ADD VALUE 'account_restore';

-- CreateIndex
CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");
