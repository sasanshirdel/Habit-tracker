import type { EmailLocale } from './mail.types.js';

/**
 * Minimal, dependency-free rendering of transactional emails (backlog P2-04, ADR-0021): one
 * accessible single-column layout in HTML plus a plain-text alternative, in the recipient's
 * language and direction. Templates give **plain strings**; every one of them is HTML-escaped
 * here, so no caller can inject markup. Links must be absolute `https:` URLs (or `http:` on a
 * loopback host for local development) and are escaped as attributes.
 */

export interface EmailAction {
  readonly label: string;
  readonly url: string;
}

export interface EmailContent {
  readonly locale: EmailLocale;
  readonly subject: string;
  /** First line most clients show in the inbox list (hidden in the body). */
  readonly preheader: string;
  readonly heading: string;
  /** Paragraphs before the button. */
  readonly intro: readonly string[];
  readonly action?: EmailAction;
  /** Paragraphs after the button (e.g. expiry, "didn't ask for this?"). */
  readonly outro: readonly string[];
  /** Small print at the bottom (why the message was sent). */
  readonly footer: string;
  /** Label before the raw link in case the button does not work. */
  readonly linkFallback?: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Writing direction per email language (asserted equal to `@habit/localization` in tests). */
export const EMAIL_DIRECTION: Record<EmailLocale, 'ltr' | 'rtl'> = { en: 'ltr', fa: 'rtl' };

const FONT_STACK: Record<EmailLocale, string> = {
  en: "Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  fa: "Vazirmatn, Tahoma, 'Segoe UI', Arial, sans-serif",
};

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Throws unless `url` is an absolute `https:` URL, or `http:` on a loopback host (local
 * development and the browser suite). Emailed links must never be relative, `javascript:` or
 * plain HTTP on a real host.
 */
export function assertEmailLinkUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('email link: not an absolute URL');
  }
  const ok =
    parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname));
  if (!ok || parsed.username || parsed.password) {
    throw new Error('email link: only https URLs (http on loopback) are allowed');
  }
}

/** Collapses CR/LF so a value can never start a new header or line where it must not. */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function renderEmail(content: EmailContent): RenderedEmail {
  if (content.action) assertEmailLinkUrl(content.action.url);
  const dir = EMAIL_DIRECTION[content.locale];
  const align = dir === 'rtl' ? 'right' : 'left';
  const subject = singleLine(content.subject);
  const e = escapeHtml;

  const paragraph = (text: string) =>
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1f2328;">${e(text)}</p>`;

  const button = content.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td style="border-radius:6px;background:#8a6420;">` +
      `<a href="${e(content.action.url)}" style="display:inline-block;padding:12px 24px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${e(content.action.label)}</a>` +
      `</td></tr></table>`
    : '';

  // The raw link is always left-to-right, even inside a right-to-left message.
  const fallback =
    content.action && content.linkFallback
      ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#59636e;">${e(content.linkFallback)}<br>` +
        `<a href="${e(content.action.url)}" dir="ltr" style="color:#8a6420;word-break:break-all;">${e(content.action.url)}</a></p>`
      : '';

  const html =
    `<!DOCTYPE html>\n` +
    `<html lang="${content.locale}" dir="${dir}">\n` +
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light"><title>${e(subject)}</title></head>\n` +
    `<body style="margin:0;padding:0;background:#f6f8fa;">` +
    `<div style="display:none;max-height:0;overflow:hidden;">${e(content.preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f8fa;"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${dir}" style="max-width:560px;background:#ffffff;border:1px solid #d1d9e0;border-radius:8px;">` +
    `<tr><td dir="${dir}" style="padding:32px;text-align:${align};font-family:${FONT_STACK[content.locale]};">` +
    `<h1 style="margin:0 0 24px;font-size:22px;line-height:1.4;color:#1f2328;">${e(content.heading)}</h1>` +
    content.intro.map(paragraph).join('') +
    button +
    content.outro.map(paragraph).join('') +
    fallback +
    `<p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#59636e;">${e(content.footer)}</p>` +
    `</td></tr></table></td></tr></table></body>\n</html>\n`;

  const textParts = [
    content.heading,
    ...content.intro,
    ...(content.action ? [`${content.action.label}:\n${content.action.url}`] : []),
    ...content.outro,
    '—',
    content.footer,
  ];
  const text = `${textParts.join('\n\n')}\n`;

  return { subject, text, html };
}
