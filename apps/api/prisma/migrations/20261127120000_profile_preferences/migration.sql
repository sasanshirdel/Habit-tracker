-- P2-07 (ADR-0024): calendar and week-start preferences.
-- Additive only: two new enum types and two columns with constant defaults (metadata-only in
-- PostgreSQL 11+, no table rewrite), then a backfill so existing Persian-language accounts get the
-- same defaults new ones do (Solar Hijri, week starting Saturday). Rollback before real data
-- exists: drop the two columns and the two types.

-- CreateEnum
CREATE TYPE "calendar_system" AS ENUM ('gregorian', 'solar_hijri');

-- CreateEnum
CREATE TYPE "week_start" AS ENUM ('saturday', 'sunday', 'monday');

-- AlterTable
ALTER TABLE "user_preferences" ADD COLUMN     "calendar" "calendar_system" NOT NULL DEFAULT 'gregorian',
ADD COLUMN     "week_start" "week_start" NOT NULL DEFAULT 'monday';

-- Backfill: registration now derives both from the account's language (fa → solar_hijri/saturday).
UPDATE "user_preferences" SET "calendar" = 'solar_hijri', "week_start" = 'saturday' WHERE "locale" = 'fa';
