import { Injectable } from '@nestjs/common';
import type { UserDataContributor } from './user-data-contributor.js';

const SECTION_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;

/**
 * The modules that contribute to the user's data export (backlog P2-10, ADR-0025). Platform code:
 * feature modules register into it (they may import platform areas), it never imports them.
 */
@Injectable()
export class UserDataExportRegistry {
  private readonly contributors = new Map<string, UserDataContributor>();

  register(contributor: UserDataContributor): void {
    if (!SECTION_NAME.test(contributor.section)) {
      throw new Error(`Invalid data export section name "${contributor.section}".`);
    }
    if (this.contributors.has(contributor.section)) {
      throw new Error(`Data export section "${contributor.section}" is registered twice.`);
    }
    for (const [table, other] of this.coveredTables()) {
      if (table in contributor.tables) {
        throw new Error(
          `Table "${table}" is claimed by data export sections "${other}" and "${contributor.section}".`,
        );
      }
    }
    this.contributors.set(contributor.section, contributor);
  }

  /** Registered contributors, sorted by section name (stable file layout). */
  list(): readonly UserDataContributor[] {
    return [...this.contributors.values()].sort((a, b) => a.section.localeCompare(b.section));
  }

  /** Every table some contributor accounts for, with the section that claims it. */
  coveredTables(): Map<string, string> {
    const tables = new Map<string, string>();
    for (const contributor of this.contributors.values()) {
      for (const table of Object.keys(contributor.tables)) tables.set(table, contributor.section);
    }
    return tables;
  }
}
