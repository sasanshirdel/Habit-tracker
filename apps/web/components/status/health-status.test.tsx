// @vitest-environment jsdom
import type { HealthResponse, ReadinessResponse } from '@habit/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import type { Locale } from '@/lib/i18n/config';
import { formats } from '@/lib/i18n/formats';
import { messages } from '@/lib/i18n/messages';
import { HealthStatus } from './health-status';

afterEach(cleanup);

const LIVE: HealthResponse = {
  status: 'ok',
  uptimeSeconds: 2 * 3600 + 5 * 60,
  timestamp: '2026-11-25T00:00:00Z',
};
const READY: ReadinessResponse = {
  status: 'ok',
  checks: { database: 'up', redis: 'up' },
  timestamp: '2026-11-25T00:00:00Z',
};

/** An ApiClient double whose GET answers per path. */
function fakeClient(answers: Record<string, () => Promise<unknown>>) {
  const get = vi.fn((path: string) => {
    const answer = answers[path];
    return answer ? answer() : Promise.reject(new ApiError('NOT_FOUND', path));
  });
  return { client: { get } as unknown as ApiClient, get };
}

function renderStatus(locale: Locale, client: ApiClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={messages[locale]}
      formats={formats}
      timeZone="UTC"
    >
      <QueryClientProvider client={queryClient}>
        <HealthStatus client={client} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const region = (name: string) => screen.getByRole('region', { name });

describe('HealthStatus (P1-12 demo)', () => {
  it('shows loading skeletons while checking, then the healthy state', async () => {
    let resolveLive: (v: HealthResponse) => void = () => {};
    const { client } = fakeClient({
      '/health': () => new Promise((resolve) => (resolveLive = resolve)),
      '/health/ready': () => Promise.resolve(READY),
    });
    renderStatus('en', client);
    expect(region('API').getAttribute('aria-busy')).toBe('true');
    expect(region('API').querySelector('[data-slot="skeleton"]')).not.toBeNull();
    resolveLive(LIVE);
    expect(await within(region('API')).findByText('Operational')).toBeTruthy();
    expect(region('API').getAttribute('aria-busy')).toBe('false');
    expect(within(region('API')).getByText('Up for 2 hours 5 minutes')).toBeTruthy();
    expect(
      await within(region('Dependencies')).findByText('All dependencies are operational.'),
    ).toBeTruthy();
    expect(screen.getByText(/^Last checked at/)).toBeTruthy();
  });

  it('treats a 503 NOT_READY as data: shows which dependency is down (fa)', async () => {
    const { client } = fakeClient({
      '/health': () => Promise.resolve(LIVE),
      '/health/ready': () =>
        Promise.reject(
          new ApiError('NOT_READY', 'not ready', {
            status: 503,
            details: { checks: { database: 'down', redis: 'up' } },
          }),
        ),
    });
    const { container } = renderStatus('fa', client);
    const deps = region('وابستگی‌ها');
    expect(await within(deps).findByText('برخی وابستگی‌ها در دسترس نیستند.')).toBeTruthy();
    expect(container.querySelector('[data-check="database"]')?.getAttribute('data-status')).toBe(
      'down',
    );
    expect(within(deps).getByText('در دسترس نیست')).toBeTruthy();
    expect(within(region('API')).getByText('فعال از ۲ ساعت و ۵ دقیقه پیش')).toBeTruthy();
  });

  it('shows a localized, announced error with the request ID and retries on demand (fa)', async () => {
    let calls = 0;
    const { client } = fakeClient({
      '/health': () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(
              new ApiError('RATE_LIMITED', 'Too Many Requests', {
                status: 429,
                requestId: 'req-42',
                retryAfterSeconds: 12,
              }),
            )
          : Promise.resolve(LIVE);
      },
      '/health/ready': () => Promise.resolve(READY),
    });
    renderStatus('fa', client);
    const alert = await within(region('API')).findByRole('alert');
    expect(alert.dataset.errorCode).toBe('RATE_LIMITED');
    expect(alert.textContent).toContain(
      'تعداد درخواست‌ها بیش از حد مجاز است. ۱۲ ثانیهٔ دیگر دوباره امتحان کنید.',
    );
    expect(alert.textContent).toContain('شناسهٔ پیگیری: \u2068req-42\u2069');
    expect(alert.textContent).not.toContain('Too Many Requests');
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'تلاش دوباره' }));
    expect(await within(region('API')).findByText('فعال')).toBeTruthy();
    expect(calls).toBe(2);
  });

  it('explains a failed connection in English and refreshes both checks', async () => {
    const { client, get } = fakeClient({
      '/health': () => Promise.reject(new ApiError('NETWORK_ERROR', 'Failed to fetch')),
      '/health/ready': () => Promise.reject(new ApiError('NETWORK_ERROR', 'Failed to fetch')),
    });
    renderStatus('en', client);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.textContent).toContain(
      "Couldn't connect. Check your internet connection and try again.",
    );
    // No request ID without a response.
    expect(alerts[0]?.textContent).not.toContain('Reference');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(4));
  });
});
