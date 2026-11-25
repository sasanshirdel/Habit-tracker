-- Identity data model (backlog P2-01, ADR-0005, ADR-0017).
--
-- Customer accounts, profiles, preferences, password credentials, sessions and single-use tokens.
-- Additive only: creates new types and tables, touches nothing that existed before.
-- Rollback (before any real data exists): DROP the six tables and four enum types below; the
-- citext extension may stay. Generated with `prisma migrate diff`, then extended by hand with the
-- extension and the CHECK constraints Prisma cannot express (listed in schema.prisma).

-- Case-insensitive email (users.email, user_tokens.email). citext is a *trusted* extension
-- (PostgreSQL 13+), so the database owner can create it without superuser rights.
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateEnum
CREATE TYPE "locale" AS ENUM ('en', 'fa');

-- CreateEnum
CREATE TYPE "theme_preference" AS ENUM ('dark', 'light', 'system');

-- CreateEnum
CREATE TYPE "user_token_purpose" AS ENUM ('email_verification', 'password_reset');

-- CreateEnum
CREATE TYPE "session_revocation_reason" AS ENUM ('sign_out', 'sign_out_everywhere', 'rotated', 'password_changed', 'account_deleted');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "user_id" UUID NOT NULL,
    "display_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "user_id" UUID NOT NULL,
    "locale" "locale" NOT NULL,
    "timezone" TEXT NOT NULL,
    "theme" "theme_preference" NOT NULL DEFAULT 'dark',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "user_password_credentials" (
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_password_credentials_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" "session_revocation_reason",

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "user_token_purpose" NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "email" CITEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),

    CONSTRAINT "user_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_token_hash_key" ON "user_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions"("user_id");

-- CreateIndex
CREATE INDEX "user_sessions_expires_at_idx" ON "user_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_tokens_token_hash_key" ON "user_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "user_tokens_user_id_purpose_idx" ON "user_tokens"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "user_tokens_expires_at_idx" ON "user_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_password_credentials" ADD CONSTRAINT "user_password_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Constraints Prisma cannot express (ADR-0017). Names follow <table>_<column>_check.

-- Emails are stored as given after normalisation by the application (trimmed); the database still
-- refuses anything that cannot be an address. 254 = RFC 5321 path limit.
ALTER TABLE "users" ADD CONSTRAINT "users_email_check"
    CHECK (char_length("email") BETWEEN 3 AND 254 AND "email" = btrim("email") AND position('@' in "email") > 1);

ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_display_name_check"
    CHECK ("display_name" IS NULL OR char_length("display_name") BETWEEN 1 AND 100);

ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_timezone_check"
    CHECK (char_length("timezone") BETWEEN 1 AND 64);

-- Only Argon2id PHC strings (ADR-0005), so a plaintext or legacy hash can never be stored.
ALTER TABLE "user_password_credentials" ADD CONSTRAINT "user_password_credentials_password_hash_check"
    CHECK ("password_hash" LIKE '$argon2id$v=19$%' AND char_length("password_hash") <= 512);

-- Token hashes are SHA-256 digests (32 bytes) of 256-bit random tokens, never the token itself.
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_token_hash_check"
    CHECK (octet_length("token_hash") = 32);
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_expires_at_check"
    CHECK ("expires_at" > "created_at");
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_revoked_check"
    CHECK (("revoked_at" IS NULL) = ("revoked_reason" IS NULL));

ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_token_hash_check"
    CHECK (octet_length("token_hash") = 32);
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_expires_at_check"
    CHECK ("expires_at" > "created_at");
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_email_check"
    CHECK ("purpose" <> 'email_verification' OR "email" IS NOT NULL);
