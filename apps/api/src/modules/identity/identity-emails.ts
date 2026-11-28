import {
  renderEmail,
  type EmailContent,
  type EmailLocale,
  type EmailMessage,
} from '../../mail/index.js';
import { EMAIL_VERIFICATION_POLICY } from './email-verification.policy.js';
import { PASSWORD_RESET_POLICY } from './password-reset.policy.js';

/**
 * Identity emails in English and Persian (backlog P2-04, ADR-0021). Copy lives here, next to the
 * flow that sends it, as typed dictionaries with identical keys for both languages (unit-tested);
 * `renderEmail` escapes every string and sets the direction (`rtl` for Persian). Numbers in the
 * Persian copy use Persian digits.
 *
 * The product name is a placeholder until the owner decides it (ROADMAP "Outstanding
 * decisions" #2); it matches the web app's `meta.title`.
 */

export const IDENTITY_EMAIL_TEMPLATES = {
  verifyEmail: 'identity.verify-email',
  alreadyRegistered: 'identity.already-registered',
  passwordReset: 'identity.password-reset',
  passwordChanged: 'identity.password-changed',
} as const;

interface VerifyCopy {
  subject: string;
  preheader: string;
  heading: string;
  intro: string;
  action: string;
  expiry: (hours: string) => string;
  ignore: string;
  linkFallback: string;
  footer: string;
}

interface AlreadyRegisteredCopy {
  subject: string;
  preheader: string;
  heading: string;
  intro: string;
  action: string;
  notYou: string;
  footer: string;
}

interface PasswordResetCopy {
  subject: string;
  preheader: string;
  heading: string;
  intro: string;
  action: string;
  expiry: (minutes: string) => string;
  ignore: string;
  linkFallback: string;
  footer: string;
}

interface PasswordChangedCopy {
  subject: string;
  preheader: string;
  heading: string;
  intro: string;
  signedOut: string;
  action: string;
  notYou: string;
  footer: string;
}

export const PRODUCT_NAME: Record<EmailLocale, string> = {
  en: 'Habit Tracker',
  fa: 'ردیاب عادت',
};

export const VERIFY_EMAIL_COPY: Record<EmailLocale, VerifyCopy> = {
  en: {
    subject: 'Confirm your email address',
    preheader: 'One click to confirm your email address for Habit Tracker.',
    heading: 'Confirm your email address',
    intro:
      'Thanks for creating a Habit Tracker account. Confirm that this email address is yours, so you can recover your account and receive important messages.',
    action: 'Confirm email address',
    expiry: (hours) =>
      `This link works once and expires in ${hours} hours. If it has expired, sign in and ask for a new one.`,
    ignore: "If you didn't create an account, you can ignore this email. Nothing will happen.",
    linkFallback: "If the button doesn't work, copy this link into your browser:",
    footer:
      'You received this email because someone signed up for Habit Tracker with this address.',
  },
  fa: {
    subject: 'نشانی ایمیل خود را تأیید کنید',
    preheader: 'با یک کلیک نشانی ایمیل خود را برای ردیاب عادت تأیید کنید.',
    heading: 'نشانی ایمیل خود را تأیید کنید',
    intro:
      'از اینکه در ردیاب عادت حساب ساختید سپاسگزاریم. تأیید کنید که این نشانی ایمیل متعلق به شماست تا بتوانید حساب خود را بازیابی کنید و پیام‌های مهم را دریافت کنید.',
    action: 'تأیید نشانی ایمیل',
    expiry: (hours) =>
      `این پیوند فقط یک بار کار می‌کند و پس از ${hours} ساعت منقضی می‌شود. اگر منقضی شده است، وارد حساب خود شوید و پیوند تازه‌ای بخواهید.`,
    ignore: 'اگر شما حسابی نساخته‌اید، این ایمیل را نادیده بگیرید. هیچ اتفاقی نمی‌افتد.',
    linkFallback: 'اگر دکمه کار نمی‌کند، این پیوند را در مرورگر خود باز کنید:',
    footer: 'این ایمیل را دریافت کرده‌اید چون کسی با این نشانی در ردیاب عادت ثبت‌نام کرده است.',
  },
};

export const ALREADY_REGISTERED_COPY: Record<EmailLocale, AlreadyRegisteredCopy> = {
  en: {
    subject: 'Someone tried to create an account with your email address',
    preheader: 'Your Habit Tracker account is unchanged.',
    heading: 'You already have an account',
    intro:
      'Someone, probably you, just tried to create a Habit Tracker account with this email address. You already have an account, and nothing about it has changed.',
    action: 'Sign in',
    notYou:
      "If this wasn't you, you can ignore this email. No one can sign in to your account without your password.",
    footer: 'You received this email because this address belongs to a Habit Tracker account.',
  },
  fa: {
    subject: 'کسی تلاش کرد با نشانی ایمیل شما حساب بسازد',
    preheader: 'حساب شما در ردیاب عادت تغییری نکرده است.',
    heading: 'شما از قبل حساب دارید',
    intro:
      'کسی، احتمالاً خود شما، همین حالا تلاش کرد با این نشانی ایمیل در ردیاب عادت حساب بسازد. شما از قبل حساب دارید و هیچ چیزی در آن تغییر نکرده است.',
    action: 'ورود',
    notYou:
      'اگر این کار شما نبود، این ایمیل را نادیده بگیرید. هیچ‌کس بدون رمز عبور شما نمی‌تواند وارد حساب شما شود.',
    footer: 'این ایمیل را دریافت کرده‌اید چون این نشانی متعلق به یک حساب در ردیاب عادت است.',
  },
};

// --- Password recovery (P2-05, ADR-0022) ---

export const PASSWORD_RESET_COPY: Record<EmailLocale, PasswordResetCopy> = {
  en: {
    subject: 'Reset your password',
    preheader: 'Choose a new password for your Habit Tracker account.',
    heading: 'Reset your password',
    intro:
      'We received a request to reset the password of the Habit Tracker account with this email address. Use the button below to choose a new password.',
    action: 'Choose a new password',
    expiry: (minutes) =>
      `This link works once and expires in ${minutes} minutes. Choosing a new password signs you out on every device.`,
    ignore:
      "If you didn't ask to reset your password, you can ignore this email. Your password stays the same.",
    linkFallback: "If the button doesn't work, copy this link into your browser:",
    footer:
      'You received this email because someone asked to reset the password of a Habit Tracker account with this address.',
  },
  fa: {
    subject: 'بازنشانی رمز عبور',
    preheader: 'برای حساب ردیاب عادت خود رمز عبور تازه‌ای انتخاب کنید.',
    heading: 'بازنشانی رمز عبور',
    intro:
      'درخواستی برای بازنشانی رمز عبور حساب ردیاب عادت با این نشانی ایمیل دریافت کردیم. با دکمهٔ زیر رمز عبور تازه‌ای انتخاب کنید.',
    action: 'انتخاب رمز عبور تازه',
    expiry: (minutes) =>
      `این پیوند فقط یک بار کار می‌کند و پس از ${minutes} دقیقه منقضی می‌شود. با انتخاب رمز عبور تازه، از همهٔ دستگاه‌ها خارج می‌شوید.`,
    ignore:
      'اگر شما درخواست بازنشانی رمز عبور نداده‌اید، این ایمیل را نادیده بگیرید. رمز عبور شما تغییری نمی‌کند.',
    linkFallback: 'اگر دکمه کار نمی‌کند، این پیوند را در مرورگر خود باز کنید:',
    footer:
      'این ایمیل را دریافت کرده‌اید چون کسی خواسته است رمز عبور حسابی در ردیاب عادت با این نشانی بازنشانی شود.',
  },
};

export const PASSWORD_CHANGED_COPY: Record<EmailLocale, PasswordChangedCopy> = {
  en: {
    subject: 'Your password was changed',
    preheader: 'The password of your Habit Tracker account was just changed.',
    heading: 'Your password was changed',
    intro: 'The password of your Habit Tracker account was just changed with a reset link.',
    signedOut:
      'For your security, every device that was signed in has been signed out. Sign in again with your new password.',
    action: 'Sign in',
    notYou:
      'If you didn\'t change your password, reset it again right away from the sign-in page ("Forgot your password?") and make sure your email account is secure.',
    footer: 'You received this email because this address belongs to a Habit Tracker account.',
  },
  fa: {
    subject: 'رمز عبور شما تغییر کرد',
    preheader: 'رمز عبور حساب ردیاب عادت شما همین حالا تغییر کرد.',
    heading: 'رمز عبور شما تغییر کرد',
    intro: 'رمز عبور حساب ردیاب عادت شما همین حالا با پیوند بازنشانی تغییر کرد.',
    signedOut:
      'برای امنیت شما، همهٔ دستگاه‌هایی که وارد حساب بودند خارج شدند. با رمز عبور تازه دوباره وارد شوید.',
    action: 'ورود',
    notYou:
      'اگر شما رمز عبور را تغییر نداده‌اید، فوراً از صفحهٔ ورود («رمز عبور را فراموش کرده‌اید؟») دوباره آن را بازنشانی کنید و از امنیت حساب ایمیل خود مطمئن شوید.',
    footer: 'این ایمیل را دریافت کرده‌اید چون این نشانی متعلق به یک حساب در ردیاب عادت است.',
  },
};

const NUMBER_LOCALE: Record<EmailLocale, string> = { en: 'en-US', fa: 'fa-IR' };

function formatNumber(locale: EmailLocale, value: number): string {
  return new Intl.NumberFormat(NUMBER_LOCALE[locale]).format(value);
}

/**
 * Link to the web app's verification page. The token goes into the URL **fragment**, which
 * browsers never send to a server (no access logs, no `Referer`); the page reads it, removes it
 * from the address bar and asks the user to confirm with a button (a GET never verifies — mail
 * scanners that open links change nothing).
 */
export function verificationLink(webAppUrl: string, locale: EmailLocale, token: string): string {
  return `${webAppUrl}/${locale}/auth/verify-email#token=${token}`;
}

export function signInLink(webAppUrl: string, locale: EmailLocale): string {
  return `${webAppUrl}/${locale}/auth/sign-in`;
}

/**
 * Link to the web app's reset page, with the token in the URL **fragment** (same pattern and
 * reasons as {@link verificationLink}): the page asks for the new password and posts both.
 */
export function passwordResetLink(webAppUrl: string, locale: EmailLocale, token: string): string {
  return `${webAppUrl}/${locale}/auth/reset-password#token=${token}`;
}

function message(to: string, template: string, content: EmailContent): EmailMessage {
  const rendered = renderEmail(content);
  return { to, template, locale: content.locale, ...rendered };
}

export function verifyEmailMessage(input: {
  to: string;
  locale: EmailLocale;
  url: string;
}): EmailMessage {
  const copy = VERIFY_EMAIL_COPY[input.locale];
  const hours = EMAIL_VERIFICATION_POLICY.tokenLifetimeMs / 3_600_000;
  return message(input.to, IDENTITY_EMAIL_TEMPLATES.verifyEmail, {
    locale: input.locale,
    subject: copy.subject,
    preheader: copy.preheader,
    heading: copy.heading,
    intro: [copy.intro],
    action: { label: copy.action, url: input.url },
    outro: [copy.expiry(formatNumber(input.locale, hours)), copy.ignore],
    linkFallback: copy.linkFallback,
    footer: copy.footer,
  });
}

export function alreadyRegisteredMessage(input: {
  to: string;
  locale: EmailLocale;
  signInUrl: string;
}): EmailMessage {
  const copy = ALREADY_REGISTERED_COPY[input.locale];
  return message(input.to, IDENTITY_EMAIL_TEMPLATES.alreadyRegistered, {
    locale: input.locale,
    subject: copy.subject,
    preheader: copy.preheader,
    heading: copy.heading,
    intro: [copy.intro],
    action: { label: copy.action, url: input.signInUrl },
    outro: [copy.notYou],
    footer: copy.footer,
  });
}

export function passwordResetMessage(input: {
  to: string;
  locale: EmailLocale;
  url: string;
}): EmailMessage {
  const copy = PASSWORD_RESET_COPY[input.locale];
  const minutes = PASSWORD_RESET_POLICY.tokenLifetimeMs / 60_000;
  return message(input.to, IDENTITY_EMAIL_TEMPLATES.passwordReset, {
    locale: input.locale,
    subject: copy.subject,
    preheader: copy.preheader,
    heading: copy.heading,
    intro: [copy.intro],
    action: { label: copy.action, url: input.url },
    outro: [copy.expiry(formatNumber(input.locale, minutes)), copy.ignore],
    linkFallback: copy.linkFallback,
    footer: copy.footer,
  });
}

export function passwordChangedMessage(input: {
  to: string;
  locale: EmailLocale;
  signInUrl: string;
}): EmailMessage {
  const copy = PASSWORD_CHANGED_COPY[input.locale];
  return message(input.to, IDENTITY_EMAIL_TEMPLATES.passwordChanged, {
    locale: input.locale,
    subject: copy.subject,
    preheader: copy.preheader,
    heading: copy.heading,
    intro: [copy.intro, copy.signedOut],
    action: { label: copy.action, url: input.signInUrl },
    outro: [copy.notYou],
    footer: copy.footer,
  });
}
