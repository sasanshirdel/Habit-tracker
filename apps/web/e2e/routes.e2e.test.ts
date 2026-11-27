import { describe, expect, inject, it } from 'vitest';

/**
 * HTTP route tests against `next start` (backlog P1-10, with the P1-08 CSP): locale negotiation,
 * `<html lang dir>`, localized content and the CSP nonce surviving the next-intl middleware.
 */
const baseUrl = inject('baseUrl');

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, { redirect: 'manual', headers });
}

function htmlTag(html: string): string {
  return /<html[^>]*>/.exec(html)?.[0] ?? '';
}

function cspNonce(res: Response): string {
  return /'nonce-([^']+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1] ?? '';
}

describe('/ negotiates the locale and redirects', () => {
  it.each([
    [{ 'accept-language': 'fa-IR,fa;q=0.9' }, '/fa'],
    [{ 'accept-language': 'en-US,en;q=0.9' }, '/en'],
    [{ 'accept-language': 'de-DE' }, '/en'],
    [{ 'accept-language': 'fa', cookie: 'NEXT_LOCALE=en' }, '/en'],
    [{ 'accept-language': 'en', cookie: 'NEXT_LOCALE=fa' }, '/fa'],
  ])('%j → %s (307, same origin, varies on the inputs)', async (headers, target) => {
    const res = await get('/', headers);
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '', baseUrl).href).toBe(`${baseUrl}${target}`);
    expect(res.headers.get('vary')).toMatch(/Accept-Language/);
    expect(res.headers.get('vary')).toMatch(/Cookie/);
  });

  it('prefixes deeper unprefixed paths and keeps the query', async () => {
    const res = await get('/pricing?plan=pro', { 'accept-language': 'fa' });
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '', baseUrl).href).toBe(
      `${baseUrl}/fa/pricing?plan=pro`,
    );
  });

  it('never redirects to another host', async () => {
    for (const path of ['//evil', '/%5Cevil', '/%2F%2Fevil/x']) {
      const res = await get(path);
      expect(new URL(res.headers.get('location') ?? '', baseUrl).origin, path).toBe(baseUrl);
    }
  });
});

describe.each([
  { locale: 'fa', dir: 'rtl', title: 'ردیاب عادت', heading: 'عادت‌های بهتر بسازید.', other: 'en' },
  {
    locale: 'en',
    dir: 'ltr',
    title: 'Habit Tracker',
    heading: 'Build better habits.',
    other: 'fa',
  },
])('/$locale', ({ locale, dir, title, heading, other }) => {
  it(`renders lang="${locale}" dir="${dir}" with localized content`, async () => {
    const res = await get(`/${locale}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const tag = htmlTag(html);
    expect(tag).toContain(`lang="${locale}"`);
    expect(tag).toContain(`dir="${dir}"`);
    expect(html).toContain(`<title>${title}</title>`);
    expect(html).toContain(heading);
    // The switcher links to the other locale's home.
    expect(html).toMatch(new RegExp(`<a[^>]+href="/${other}"`));
    // Dates/numbers in the page follow the locale's digits.
    const time = /<time[^>]*>([^<]+)<\/time>/.exec(html)?.[1] ?? '';
    expect(time).toMatch(locale === 'fa' ? /[۰-۹]/ : /[0-9]/);
    expect(time).not.toMatch(locale === 'fa' ? /[0-9]/ : /[۰-۹]/);
  });

  it('keeps the per-request CSP nonce on every script (P1-08 through next-intl)', async () => {
    const res = await get(`/${locale}`);
    const nonce = cspNonce(res);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    const html = await res.text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).toContain(`nonce="${nonce}"`);
    expect(cspNonce(await get(`/${locale}`))).not.toBe(nonce);
  });

  it('sends hreflang alternates and the static security headers', async () => {
    const res = await get(`/${locale}`);
    expect(res.headers.get('link')).toContain('hreflang="fa"');
    expect(res.headers.get('link')).toContain('hreflang="en"');
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it(`remembers /${locale} in a Secure, SameSite=Lax cookie when the browser prefers another`, async () => {
    const res = await get(`/${locale}`, { 'accept-language': other });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(new RegExp(`^NEXT_LOCALE=${locale};`));
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=lax/i);
  });
});

describe('unknown paths', () => {
  it('404 under a locale with the localized not-found tree (fa, rtl)', async () => {
    const res = await get('/fa/does-not-exist');
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('noindex');
    // Next.js 16.4 draws a render-time notFound() in the browser: the localized tree (inside the
    // locale layout, with lang/dir) is in the RSC payload, the server HTML is the error shell.
    // When upstream fixes vercel/next.js#99793 the first branch takes over — tighten it then.
    if (htmlTag(html).includes('__next_error__')) {
      expect(html).toContain('صفحه پیدا نشد');
      expect(html).toMatch(/\\"lang\\":\\"fa\\",\\"dir\\":\\"rtl\\"/);
    } else {
      expect(htmlTag(html)).toContain('dir="rtl"');
      expect(html).toContain('صفحه پیدا نشد');
    }
  });

  it('an unsupported locale segment never renders as a locale', async () => {
    const res = await get('/de', { 'accept-language': 'en' });
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '', baseUrl).pathname).toBe('/en/de');
  });
});

describe('design system (P1-09)', () => {
  it.each([
    [undefined, 'dark'],
    ['theme=light', 'light'],
    ['theme=system', 'system'],
    ['theme=dark', 'dark'],
    ['theme=%3Cscript%3E', 'dark'],
  ])(
    'theme cookie %s renders data-theme="%s" on the first byte (no flash)',
    async (cookie, theme) => {
      const res = await get('/en', cookie ? { cookie } : {});
      expect(htmlTag(await res.text())).toContain(`data-theme="${theme}"`);
    },
  );

  it('serves the self-hosted variable fonts from its own origin (no font CDN)', async () => {
    const html = await (await get('/fa')).text();
    const stylesheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(
      (m) => m[1] ?? '',
    );
    expect(stylesheets.length).toBeGreaterThan(0);
    const css = (await Promise.all(stylesheets.map(async (href) => (await get(href)).text()))).join(
      '\n',
    );
    expect(css).toMatch(/font-family:\s*Inter Variable/);
    expect(css).toMatch(/font-family:\s*Vazirmatn Variable/);
    expect(css).not.toMatch(/fonts\.(googleapis|gstatic)\.com|url\(\s*["']?https?:/);
    const vazirmatn = /url\(([^)]*vazirmatn-arabic-wght-normal[^)]*\.woff2)\)/.exec(css)?.[1];
    expect(vazirmatn).toBeDefined();
    const font = await get(new URL(vazirmatn ?? '', `${baseUrl}${stylesheets[0]}`).pathname);
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/woff2');
  });

  it('applies the theme tokens, including `system` through prefers-color-scheme', async () => {
    const html = await (await get('/en')).text();
    const href = /<link rel="stylesheet" href="([^"]+)"/.exec(html)?.[1] ?? '';
    const css = await (await get(href)).text();
    expect(css).toMatch(/\[data-theme=light\]\{[^}]*--token-accent:#8a6420/);
    expect(css).toMatch(/prefers-color-scheme:\s*light\)\{\[data-theme=system\]/);
  });

  it('renders the localized theme switcher and toast region', async () => {
    const html = await (await get('/fa', { cookie: 'theme=light' })).text();
    expect(html).toContain('aria-label="پوسته: روشن"');
    expect(html).toContain('aria-label="اعلان‌ها"');
    const en = await (await get('/en')).text();
    expect(en).toContain('aria-label="Theme: Dark"');
  });
});

describe('application shell (P1-11)', () => {
  const sectionPaths = [
    'overview',
    'habits',
    'goals',
    'tasks',
    'planner',
    'focus',
    'journal',
    'insights',
    'coach',
    'settings',
  ];

  /** The opening tag and contents of the first `<nav>` carrying `data-nav="…"`. */
  function navBlock(html: string, kind: 'sidebar' | 'bottom'): string {
    const start = html.search(new RegExp(`<nav[^>]*data-nav="${kind}"`));
    if (start < 0) return '';
    return html.slice(start, html.indexOf('</nav>', start) + '</nav>'.length);
  }

  describe.each([
    { locale: 'fa', dir: 'rtl', nav: 'اصلی', skip: 'رفتن به محتوای اصلی', habits: 'عادت‌ها' },
    { locale: 'en', dir: 'ltr', nav: 'Main', skip: 'Skip to main content', habits: 'Habits' },
  ])('/$locale', ({ locale, dir, nav, skip, habits }) => {
    it.each(sectionPaths)(
      `/${locale}/%s renders inside the shell (200, lang, dir)`,
      async (path) => {
        const res = await get(`/${locale}/${path}`);
        expect(res.status).toBe(200);
        const html = await res.text();
        const tag = htmlTag(html);
        expect(tag).toContain(`lang="${locale}"`);
        expect(tag).toContain(`dir="${dir}"`);
        expect(html).toMatch(/<main[^>]*id="main"/);
        // P2-09: the server cannot know the session (the cookie lives on the API origin), so the
        // page content is held back by the auth gate — no flash of app content before the check.
        expect(html).toContain('data-auth-gate="checking"');
        expect(html).not.toMatch(/<h1[^>]*>[^<]+<\/h1>/);
        expect(html).not.toContain('data-slot="empty-state"');
        // App pages are not for search engines.
        expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"/);
      },
    );

    it('has the landmarks: skip link first, labelled navigation, banner, main', async () => {
      const html = await (await get(`/${locale}/habits`)).text();
      const body = html.slice(html.indexOf('<body'));
      const firstLink = /<a\b[^>]*>([^<]*)<\/a>/.exec(body);
      expect(firstLink?.[0]).toContain('href="#main"');
      expect(firstLink?.[1]).toBe(skip);
      expect(html).toMatch(/<header\b/);
      expect(html).toMatch(
        /<main[^>]*id="main"[^>]*tabindex="-1"|<main[^>]*tabindex="-1"[^>]*id="main"/i,
      );
      for (const kind of ['sidebar', 'bottom'] as const) {
        expect(navBlock(html, kind), kind).toContain(`aria-label="${nav}"`);
      }
    });

    it('links every section, locale-prefixed, and marks the current one', async () => {
      const html = await (await get(`/${locale}/habits`)).text();
      const sidebar = navBlock(html, 'sidebar');
      for (const path of sectionPaths) {
        expect(sidebar, path).toMatch(new RegExp(`<a[^>]+href="/${locale}/${path}"`));
      }
      const current = [...sidebar.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)];
      expect(current).toHaveLength(1);
      expect(current[0]?.[0]).toContain(`href="/${locale}/habits"`);
      expect(sidebar).toContain(habits);
      // Mobile: four sections and the "More" button.
      const bottom = navBlock(html, 'bottom');
      expect([...bottom.matchAll(/<a\b/g)]).toHaveLength(4);
      expect(bottom).toMatch(/<button[^>]*aria-haspopup="dialog"/);
    });

    it('switches language on the same page', async () => {
      const other = locale === 'fa' ? 'en' : 'fa';
      const html = await (await get(`/${locale}/tasks`)).text();
      expect(html).toMatch(
        new RegExp(
          `<a[^>]+href="/${other}/tasks"[^>]*hrefLang="${other}"|<a[^>]+hrefLang="${other}"[^>]*href="/${other}/tasks"`,
          'i',
        ),
      );
    });

    it('keeps the per-request CSP nonce on every script', async () => {
      const res = await get(`/${locale}/overview`);
      const nonce = cspNonce(res);
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      const scripts = (await res.text()).match(/<script\b[^>]*>/g) ?? [];
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) expect(script).toContain(`nonce="${nonce}"`);
    });
  });

  it('localizes the page title per section', async () => {
    expect(await (await get('/en/journal')).text()).toContain(
      '<title>Journal · Habit Tracker</title>',
    );
    expect(await (await get('/fa/journal')).text()).toContain(
      '<title>یادداشت روزانه · ردیاب عادت</title>',
    );
  });

  it('unprefixed section paths redirect to the negotiated locale', async () => {
    const res = await get('/habits', { 'accept-language': 'fa' });
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '', baseUrl).pathname).toBe('/fa/habits');
  });

  it('unknown pages below a section still 404', async () => {
    expect((await get('/en/habits/does-not-exist')).status).toBe(404);
  });

  it('the landing page links to sign-up and sign-in (ROADMAP decision #10 interim, P2-09)', async () => {
    const html = await (await get('/en')).text();
    expect(html).toMatch(/<a[^>]+href="\/en\/auth\/sign-up"/);
    expect(html).toMatch(/<a[^>]+href="\/en\/auth\/sign-in"/);
  });
});

describe('status page — frontend data layer demo (P1-12)', () => {
  it.each([
    { locale: 'fa', dir: 'rtl', heading: 'وضعیت سامانه' },
    { locale: 'en', dir: 'ltr', heading: 'System status' },
  ])(
    '/$locale/status renders the localized page with loading states',
    async ({ locale, dir, heading }) => {
      const res = await get(`/${locale}/status`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(htmlTag(html)).toContain(`lang="${locale}"`);
      expect(htmlTag(html)).toContain(`dir="${dir}"`);
      expect(html).toMatch(new RegExp(`<h1[^>]*>${heading}</h1>`));
      // The checks run in the browser: the server HTML holds both sections busy with skeletons.
      expect([...html.matchAll(/aria-busy="true"/g)]).toHaveLength(2);
      expect(html).toContain('data-slot="skeleton"');
      expect(html).toMatch(/<meta name="robots" content="noindex"/);
    },
  );

  it('keeps the CSP nonce on every script of the status page', async () => {
    const res = await get('/en/status');
    const nonce = cspNonce(res);
    const scripts = (await res.text()).match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).toContain(`nonce="${nonce}"`);
  });

  it('is linked from the landing page', async () => {
    expect(await (await get('/fa')).text()).toMatch(/<a[^>]+href="\/fa\/status"/);
  });
});

describe('auth pages (P2-09)', () => {
  /**
   * The opening tag of the input labelled by `<label for=…>` with this text, lower-cased (React
   * writes `autoComplete=`; HTML attribute names are case-insensitive).
   */
  function inputFor(html: string, label: string): string {
    const forId = new RegExp(`<label[^>]*for="([^"]+)"[^>]*>${label}</label>`).exec(html)?.[1];
    if (!forId) return '';
    const id = forId.replace(/[^\w-]/g, '\\$&');
    return new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)?.[0]?.toLowerCase() ?? '';
  }

  describe.each([
    {
      locale: 'fa',
      dir: 'rtl',
      email: 'ایمیل',
      password: 'رمز عبور',
      signIn: 'ورود',
      signUp: 'ساخت حساب کاربری',
    },
    {
      locale: 'en',
      dir: 'ltr',
      email: 'Email',
      password: 'Password',
      signIn: 'Sign in',
      signUp: 'Create your account',
    },
  ])('/$locale', ({ locale, dir, email, password, signIn, signUp }) => {
    it('sign-in: localized, labelled fields with the right autocomplete, nonce on every script', async () => {
      const res = await get(`/${locale}/auth/sign-in`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(htmlTag(html)).toContain(`dir="${dir}"`);
      expect(html).toMatch(new RegExp(`<h1[^>]*>${signIn}</h1>`));
      expect(html).toMatch(/<form[^>]*novalidate/i);
      const emailInput = inputFor(html, email);
      expect(emailInput).toContain('type="email"');
      expect(emailInput).toContain('autocomplete="username"');
      expect(emailInput).toContain('dir="ltr"');
      const passwordInput = inputFor(html, password);
      expect(passwordInput).toContain('type="password"');
      expect(passwordInput).toContain('autocomplete="current-password"');
      expect(html).toMatch(/<button[^>]*aria-pressed="false"/);
      const nonce = cspNonce(res);
      for (const script of html.match(/<script\b[^>]*>/g) ?? []) {
        expect(script).toContain(`nonce="${nonce}"`);
      }
    });

    it('sign-up: new-password and the password rule linked to the field', async () => {
      const html = await (await get(`/${locale}/auth/sign-up`)).text();
      expect(html).toMatch(new RegExp(`<h1[^>]*>${signUp}</h1>`));
      expect(inputFor(html, email)).toContain('autocomplete="email"');
      const passwordInput = inputFor(html, password);
      expect(passwordInput).toContain('autocomplete="new-password"');
      const hintId = /aria-describedby="([^"]+)"/.exec(passwordInput)?.[1];
      expect(hintId).toBeTruthy();
      // `toBe(true)`, not `toMatch`: a failure should not print the whole page.
      expect(new RegExp(`<p[^>]*id="${hintId}"`, 'i').test(html)).toBe(true);
    });
  });

  it.each(['en', 'fa'] as const)(
    'verify-email (/%s, P2-04): noindex, localized, and the server HTML holds no confirm action yet',
    async (locale) => {
      const res = await get(`/${locale}/auth/verify-email`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(htmlTag(html)).toContain(`dir="${locale === 'fa' ? 'rtl' : 'ltr'}"`);
      expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"/);
      expect(html).toContain('data-verify-step="reading"');
      // The token lives in the URL fragment, read by the browser only: nothing to render here.
      expect(html).not.toContain('data-verify-step="ready"');
    },
  );

  it('/{locale}/auth itself is not a page', async () => {
    expect((await get('/en/auth')).status).toBe(404);
  });

  it('carries only a safe `next` into the links between the auth pages (no open redirect)', async () => {
    const safe = await (await get('/en/auth/sign-in?next=%2Fhabits%2F7')).text();
    expect(safe).toContain('href="/en/auth/sign-up?next=%2Fhabits%2F7"');
    for (const evil of [
      'https://evil.example/',
      '//evil.example',
      '/%09/evil.example',
      '/auth/sign-in',
    ]) {
      const html = await (await get(`/en/auth/sign-in?next=${encodeURIComponent(evil)}`)).text();
      expect(html, evil).toContain('href="/en/auth/sign-up"');
      expect(html, evil).not.toMatch(/href="[^"]*evil/);
    }
  });
});
