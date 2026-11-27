import { describe, expect, it } from 'vitest';
import {
  EMAIL_MAX_LENGTH,
  PASSWORD_INPUT_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  currentPasswordSchema,
  emailAddressSchema,
  newPasswordSchema,
  normalizePassword,
} from './index.js';

describe('emailAddressSchema', () => {
  it('trims and lower-cases (the citext equality the database applies)', () => {
    expect(emailAddressSchema.parse('  Sara.Ahmadi+Habits@Example.COM \n')).toBe(
      'sara.ahmadi+habits@example.com',
    );
  });

  it('keeps provider-specific forms distinct (no Gmail dot/tag rewriting)', () => {
    expect(emailAddressSchema.parse('a.b+c@gmail.com')).toBe('a.b+c@gmail.com');
  });

  it(`accepts exactly ${EMAIL_MAX_LENGTH} characters and rejects one more`, () => {
    // "a@" + three 63-character labels + a 56-character label + ".com" = 254 characters.
    const label = 'b'.repeat(63);
    const ok = `a@${label}.${label}.${label}.${'c'.repeat(56)}.com`;
    expect(ok.length).toBe(EMAIL_MAX_LENGTH);
    expect(emailAddressSchema.safeParse(ok).success).toBe(true);
    expect(emailAddressSchema.safeParse(`a${ok}`).success).toBe(false);
  });

  it.each(['', 'no-at-sign', '@example.com', 'a@', 'a b@example.com', 'a@b', 1, null])(
    'rejects %j',
    (value) => {
      expect(emailAddressSchema.safeParse(value).success).toBe(false);
    },
  );

  it('rejects huge input before normalising it', () => {
    expect(emailAddressSchema.safeParse(`${'a'.repeat(2000)}@example.com`).success).toBe(false);
  });
});

describe('newPasswordSchema', () => {
  it('accepts the bounds, counting code points after NFKC', () => {
    expect(newPasswordSchema.parse('a'.repeat(PASSWORD_MIN_LENGTH))).toHaveLength(8);
    expect(newPasswordSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH)).success).toBe(true);
    // Persian letters (one UTF-16 unit each) and emoji (two units each) count as one character.
    expect(newPasswordSchema.safeParse('رمزعبورم').success).toBe(true);
    expect(newPasswordSchema.safeParse('🔑'.repeat(PASSWORD_MIN_LENGTH)).success).toBe(true);
    expect(newPasswordSchema.safeParse('🔑'.repeat(PASSWORD_MAX_LENGTH)).success).toBe(true);
  });

  it('rejects too short and too long with zod size codes, never echoing the value', () => {
    const short = newPasswordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH - 1));
    expect(short.success).toBe(false);
    expect(short.error?.issues.map((i) => i.code)).toEqual(['too_small']);
    expect(JSON.stringify(short.error?.issues)).not.toContain('aaaaaaa');

    const long = newPasswordSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH + 1));
    expect(long.success).toBe(false);
    expect(long.error?.issues.map((i) => i.code)).toEqual(['too_big']);

    expect(newPasswordSchema.safeParse('a'.repeat(PASSWORD_INPUT_MAX_LENGTH + 1)).success).toBe(
      false,
    );
  });

  it('allows spaces and does not trim or truncate', () => {
    expect(newPasswordSchema.parse('  correct horse  ')).toBe('  correct horse  ');
  });

  it.each([undefined, null, 12345678, ['password']])('rejects non-strings: %j', (value) => {
    expect(newPasswordSchema.safeParse(value).success).toBe(false);
  });
});

describe('normalizePassword / currentPasswordSchema', () => {
  it('maps canonically equivalent and compatibility forms to one string (NFKC)', () => {
    const composed = 'caf\u00e9-pass';
    const decomposed = 'cafe\u0301-pass';
    expect(normalizePassword(decomposed)).toBe(composed);
    expect(normalizePassword('ｐａｓｓｗｏｒｄ')).toBe('password'); // full-width forms
    expect(currentPasswordSchema.parse(decomposed)).toBe(composed);
  });

  it('only bounds the sign-in password (no policy)', () => {
    expect(currentPasswordSchema.parse('short')).toBe('short');
    expect(currentPasswordSchema.safeParse('').success).toBe(false);
    expect(currentPasswordSchema.safeParse('a'.repeat(PASSWORD_INPUT_MAX_LENGTH + 1)).success).toBe(
      false,
    );
  });
});
