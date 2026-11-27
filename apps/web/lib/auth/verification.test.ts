import { describe, expect, it } from 'vitest';
import { verificationTokenFromHash } from './verification';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

describe('verificationTokenFromHash (P2-04)', () => {
  it('reads a well-formed token from #token=…', () => {
    expect(TOKEN).toHaveLength(43);
    expect(verificationTokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(verificationTokenFromHash(`token=${TOKEN}`)).toBe(TOKEN);
    expect(verificationTokenFromHash(`#utm=x&token=${TOKEN}`)).toBe(TOKEN);
  });

  it.each([
    ['no hash', ''],
    ['empty hash', '#'],
    ['other parameter', `#code=${TOKEN}`],
    ['too short', '#token=abc'],
    ['too long', `#token=${TOKEN}x`],
    ['bad characters', `#token=${TOKEN.slice(0, 42)}+`],
    ['markup', '#token=<script>alert(1)</script>'],
    ['oversized hash', `#token=${'a'.repeat(300)}`],
  ])('returns null for %s', (_name, hash) => {
    expect(verificationTokenFromHash(hash)).toBeNull();
  });
});
