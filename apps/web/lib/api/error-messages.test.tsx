// @vitest-environment jsdom
import { API_ERROR_CODES } from '@habit/shared-types';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import type { Locale } from '../i18n/config';
import { formats } from '../i18n/formats';
import { messages } from '../i18n/messages';
import { useErrorMessage } from './error-messages';
import { ApiError, CLIENT_ERROR_CODES, ERROR_CODES } from './errors';

afterEach(cleanup);

function Message({ error }: { error: unknown }) {
  return <p>{useErrorMessage()(error)}</p>;
}

function show(locale: Locale, error: unknown): string {
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={messages[locale]}
      formats={formats}
      timeZone="UTC"
    >
      <Message error={error} />
    </NextIntlClientProvider>,
  );
  const text = screen.getByRole('paragraph').textContent ?? '';
  cleanup();
  return text;
}

describe('localized API error messages (P1-12)', () => {
  it('has a message for every API error code (shared list) and every client code, in fa and en', () => {
    expect(ERROR_CODES).toEqual([...API_ERROR_CODES, ...CLIENT_ERROR_CODES]);
    for (const locale of ['en', 'fa'] as const) {
      const catalogue = messages[locale].apiErrors as Record<string, string>;
      for (const code of [...ERROR_CODES, 'UNKNOWN']) {
        expect(catalogue[code], `${locale}.apiErrors.${code}`).toBeTruthy();
      }
    }
  });

  it('localizes by code, never showing the developer message', () => {
    const error = new ApiError('FORBIDDEN', 'Missing scope habits:write', { status: 403 });
    expect(show('en', error)).toBe("You don't have permission to do that.");
    expect(show('fa', error)).toBe('اجازهٔ انجام این کار را ندارید.');
    expect(show('en', error)).not.toContain('scope');
  });

  it('tells how long to wait when rate limited (Persian digits in fa)', () => {
    const wait = (s?: number) => new ApiError('RATE_LIMITED', 'x', { retryAfterSeconds: s });
    expect(show('en', wait(30))).toBe('Too many requests. Try again in 30 seconds.');
    expect(show('en', wait(1))).toBe('Too many requests. Try again in 1 second.');
    expect(show('en', wait())).toBe('Too many requests. Try again in a moment.');
    expect(show('fa', wait(30))).toBe(
      'تعداد درخواست‌ها بیش از حد مجاز است. ۳۰ ثانیهٔ دیگر دوباره امتحان کنید.',
    );
    expect(show('fa', wait())).toBe(
      'تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره امتحان کنید.',
    );
  });

  it('covers failures without a response and unknown errors', () => {
    expect(show('en', new ApiError('NETWORK_ERROR', 'x'))).toMatch(/^Couldn't connect/);
    expect(show('fa', new ApiError('TIMEOUT', 'x'))).toBe(
      'پاسخ سرور بیش از حد طول کشید. دوباره امتحان کنید.',
    );
    expect(show('en', new Error('boom'))).toBe('Something went wrong. Try again.');
    expect(show('fa', 'nope')).toBe('مشکلی پیش آمد. دوباره امتحان کنید.');
  });
});
