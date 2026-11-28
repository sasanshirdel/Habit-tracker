import { describe, expect, it } from 'vitest';
import {
  PASSWORD_INPUT_MAX_LENGTH,
  accountDeletionSchema,
  deletionConfirmationMatches,
} from './index.js';

// Backlog P2-10 (ADR-0025): account deletion re-authenticates with the current password; the
// typed confirmation is a browser-side step.
describe('accountDeletionSchema', () => {
  it('accepts any non-empty password up to the input bound, NFKC-normalised', () => {
    expect(accountDeletionSchema.parse({ password: 'x' })).toEqual({ password: 'x' });
    // U+FB01 (ﬁ ligature) normalises to "fi", like sign-in.
    expect(accountDeletionSchema.parse({ password: '\uFB01ne' }).password).toBe('fine');
  });

  it('rejects an empty or oversized password', () => {
    expect(accountDeletionSchema.safeParse({ password: '' }).success).toBe(false);
    expect(
      accountDeletionSchema.safeParse({ password: 'a'.repeat(PASSWORD_INPUT_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(accountDeletionSchema.safeParse({}).success).toBe(false);
  });
});

describe('deletionConfirmationMatches', () => {
  it('matches the account address, trimmed and case-insensitively', () => {
    expect(deletionConfirmationMatches(' Ada@Example.test ', 'ada@example.test')).toBe(true);
  });

  it('rejects anything else, including an empty address', () => {
    expect(deletionConfirmationMatches('ada@example.tes', 'ada@example.test')).toBe(false);
    expect(deletionConfirmationMatches('', 'ada@example.test')).toBe(false);
    expect(deletionConfirmationMatches('', '')).toBe(false);
  });
});
