import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CSRF_HEADER, CSRF_TOKEN_LENGTH, csrfTokenFor, csrfTokenMatches } from './csrf-token.js';
import { issueSecretToken } from './secret-token.js';

// Backlog P2-03 (ADR-0019): the session-bound CSRF token.
describe('csrfTokenFor', () => {
  it('is deterministic per session token, 43 base64url characters', () => {
    const { token } = issueSecretToken();
    const csrf = csrfTokenFor(token);
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrf).toHaveLength(CSRF_TOKEN_LENGTH);
    expect(csrfTokenFor(token)).toBe(csrf);
  });

  it('differs between sessions and from the session token and its stored hash', () => {
    const a = issueSecretToken();
    const b = issueSecretToken();
    expect(csrfTokenFor(a.token)).not.toBe(csrfTokenFor(b.token));
    expect(csrfTokenFor(a.token)).not.toBe(a.token);
    // The database keeps SHA-256(token); the CSRF token is a different function of the token.
    expect(csrfTokenFor(a.token)).not.toBe(Buffer.from(a.hash).toString('base64url'));
    expect(csrfTokenFor(a.token)).not.toBe(
      createHash('sha256').update(a.token).digest('base64url'),
    );
  });

  it('is pinned (HMAC-SHA256 keyed by the session token over "habit/csrf/v1")', () => {
    expect(csrfTokenFor('session')).toBe('Bd10YgnGtEIOUV4E46SWMylxGJv8tXgaQ2ljxZLIys0');
  });

  it('uses the header name the web client sends', () => {
    expect(CSRF_HEADER).toBe('X-CSRF-Token');
  });
});

describe('csrfTokenMatches', () => {
  const expected = csrfTokenFor(issueSecretToken().token);
  it('accepts only the exact token', () => {
    expect(csrfTokenMatches(expected, expected)).toBe(true);
    const last = expected.at(-1) === 'A' ? 'B' : 'A';
    expect(csrfTokenMatches(`${expected.slice(0, -1)}${last}`, expected)).toBe(false);
  });
  it.each([undefined, '', 'short', ['a', 'b'], 42, `${'é'.repeat(43)}`])('rejects %j', (value) => {
    expect(csrfTokenMatches(value, expected)).toBe(false);
  });
});
