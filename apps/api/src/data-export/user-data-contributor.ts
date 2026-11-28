import type { DatabaseTransaction } from '../database/index.js';

/**
 * One feature module's part of the user's data export (backlog P2-10, ADR-0025).
 *
 * Every module that stores rows belonging to a user registers exactly one contributor with
 * {@link UserDataExportRegistry} (in `onModuleInit`). The export runs all contributors inside one
 * read-only, repeatable-read transaction, so the file is a consistent snapshot.
 *
 * Rules for `collect`:
 * - read **only** `userId`'s rows, through the given transaction (never another client);
 * - return plain JSON (strings, numbers, booleans, null, arrays, objects; instants as ISO 8601);
 * - never include secrets (password hashes, session or link token hashes) or other users' data;
 * - never log what it returns.
 */
export interface UserDataContributor {
  /** Section name in the export (`sections.<name>`), `camelCase`, unique across modules. */
  readonly section: string;
  /**
   * Every table with user-owned rows this module has, mapped to how the export covers it:
   * `included` (its rows are in the section) or the reason it is left out (e.g. a secret). An
   * integration test compares the union of all contributors with the database's tables that
   * reference `users`, so a new table without an export decision fails CI.
   */
  readonly tables: Readonly<Record<string, 'included' | { readonly excluded: string }>>;
  collect(db: DatabaseTransaction, userId: string): Promise<unknown>;
}
