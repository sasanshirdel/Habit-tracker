import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashSecretToken,
  isWellFormedSecretToken,
  issueSecretToken,
  SECRET_TOKEN_HASH_BYTES,
  SECRET_TOKEN_LENGTH,
  secretTokenHashesEqual,
} from './index.js';

describe('secret tokens (P2-01)', () => {
  it('issues 256-bit base64url tokens with a 32-byte SHA-256 hash', () => {
    const { token, hash } = issueSecretToken();
    expect(token).toHaveLength(SECRET_TOKEN_LENGTH);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.byteLength).toBe(SECRET_TOKEN_HASH_BYTES);
    expect(Buffer.from(hash).equals(createHash('sha256').update(token).digest())).toBe(true);
  });

  it('never returns the token itself as the stored value', () => {
    const { token, hash } = issueSecretToken();
    expect(Buffer.from(hash).toString('base64url')).not.toBe(token);
    expect(Buffer.from(hash).toString('utf8')).not.toContain(token);
  });

  it('issues a different token every time', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => issueSecretToken().token));
    expect(tokens.size).toBe(1000);
  });

  it('hashes a presented token to the stored hash', () => {
    const { token, hash } = issueSecretToken();
    const presented = hashSecretToken(token);
    expect(presented).not.toBeNull();
    expect(secretTokenHashesEqual(presented!, hash)).toBe(true);
    expect(secretTokenHashesEqual(hashSecretToken(issueSecretToken().token)!, hash)).toBe(false);
  });

  it('every issued token is well formed (canonical encoding)', () => {
    for (let i = 0; i < 2000; i++) {
      expect(isWellFormedSecretToken(issueSecretToken().token)).toBe(true);
    }
  });

  it.each([
    ['undefined', undefined],
    ['a number', 42],
    ['an empty string', ''],
    ['too short', 'A'.repeat(42)],
    ['too long', 'A'.repeat(44)],
    ['standard base64 characters', `${'A'.repeat(41)}+A`],
    ['padding', `${'A'.repeat(42)}=`],
    ['non-canonical last character', `${'A'.repeat(42)}B`],
    ['surrounding whitespace', ` ${'A'.repeat(43)}`],
    ['non-ASCII', `${'A'.repeat(42)}ا`],
  ])('rejects %s without hashing it', (_label, value) => {
    expect(isWellFormedSecretToken(value)).toBe(false);
    expect(hashSecretToken(value)).toBeNull();
  });

  it('compares hashes only when both are 32 bytes', () => {
    const { hash } = issueSecretToken();
    expect(secretTokenHashesEqual(hash, hash.slice(0, 31))).toBe(false);
    expect(secretTokenHashesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(false);
    expect(secretTokenHashesEqual(hash, new Uint8Array(hash))).toBe(true);
  });
});
