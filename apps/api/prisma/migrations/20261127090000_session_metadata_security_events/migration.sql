-- P2-08 (ADR-0023): coarse session metadata and the per-account security event log.
-- Additive only: new enum types, one new enum value, three columns with constant defaults
-- (metadata-only in PostgreSQL 11+, no table rewrite) and one new table. Existing sessions get
-- 'unknown'. Rollback before real data exists: drop "user_security_events", the three columns and
-- the four new types ('revoked_by_user' cannot be removed from an enum; it is harmless unused).

-- CreateEnum
CREATE TYPE "client_browser" AS ENUM ('chrome', 'edge', 'firefox', 'safari', 'opera', 'samsung_internet', 'unknown');

-- CreateEnum
CREATE TYPE "client_os" AS ENUM ('windows', 'macos', 'ios', 'android', 'linux', 'chromeos', 'unknown');

-- CreateEnum
CREATE TYPE "client_device" AS ENUM ('desktop', 'mobile', 'tablet', 'unknown');

-- CreateEnum
CREATE TYPE "security_event_type" AS ENUM ('sign_in', 'sign_out', 'signed_out_everywhere', 'signed_out_other_sessions', 'session_revoked', 'password_reset', 'email_verified');

-- AlterEnum
ALTER TYPE "session_revocation_reason" ADD VALUE 'revoked_by_user';

-- AlterTable
ALTER TABLE "user_sessions" ADD COLUMN     "client_browser" "client_browser" NOT NULL DEFAULT 'unknown',
ADD COLUMN     "client_device" "client_device" NOT NULL DEFAULT 'unknown',
ADD COLUMN     "client_os" "client_os" NOT NULL DEFAULT 'unknown';

-- CreateTable
CREATE TABLE "user_security_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "security_event_type" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "client_browser" "client_browser" NOT NULL DEFAULT 'unknown',
    "client_os" "client_os" NOT NULL DEFAULT 'unknown',
    "client_device" "client_device" NOT NULL DEFAULT 'unknown',

    CONSTRAINT "user_security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_security_events_user_id_created_at_idx" ON "user_security_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "user_security_events_created_at_idx" ON "user_security_events"("created_at");

-- AddForeignKey
ALTER TABLE "user_security_events" ADD CONSTRAINT "user_security_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

