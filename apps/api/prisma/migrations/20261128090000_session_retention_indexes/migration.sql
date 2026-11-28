-- Daily retention clean-up of ended sessions (ADR-0026, ADR-0023): the job deletes sessions that
-- were revoked, expired or went idle more than 30 days ago across all accounts. `expires_at` is
-- already indexed (ADR-0017); these two let PostgreSQL find the other two cases without scanning
-- the table. Additive only.

-- CreateIndex
CREATE INDEX "user_sessions_revoked_at_idx" ON "user_sessions"("revoked_at");

-- CreateIndex
CREATE INDEX "user_sessions_last_used_at_idx" ON "user_sessions"("last_used_at");
