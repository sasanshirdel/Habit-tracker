import type { Prisma } from '../generated/prisma/client.js';

/**
 * The client a `prisma.$transaction(async (tx) => …)` callback receives. Exported for platform
 * areas that hand a transaction to feature modules (P2-10: the data export runs every module's
 * contribution inside one read-only snapshot) without importing the generated client themselves
 * (ADR-0016: only `database/` and feature modules may).
 */
export type DatabaseTransaction = Prisma.TransactionClient;
