import { describe, expect, it } from 'vitest';
import { afterSignInPath, safeNextPath, signInHref, signUpHref } from './redirect';

describe('safeNextPath (open-redirect guard, P2-09)', () => {
  it.each([
    ['/overview', '/overview'],
    ['/habits', '/habits'],
    ['/habits/123?tab=history#week', '/habits/123?tab=history#week'],
    ['/settings', '/settings'],
    ['/fa/habits', '/habits'],
    ['/en/tasks?view=board', '/tasks?view=board'],
    ['/habits/../goals', '/goals'],
  ])('keeps the in-app path %s', (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected);
  });

  it.each([
    'https://evil.example/overview',
    'http:evil.example',
    '//evil.example/overview',
    '///evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    ' /overview',
    'javascript:alert(1)',
    'data:text/html,hi',
    'overview',
    '',
    '/',
    '/fa',
    '/auth/sign-in',
    '/auth/sign-up?next=/overview',
    '/api/v1/auth/logout',
    '/status',
    '/overviewx',
    '/habits/../../evil.example',
    `/habits/${'x'.repeat(600)}`,
  ])('rejects %j', (raw) => {
    expect(safeNextPath(raw)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });

  it('falls back to the app home', () => {
    expect(afterSignInPath('//evil.example')).toBe('/overview');
    expect(afterSignInPath('/journal')).toBe('/journal');
  });

  it('builds sign-in/sign-up links that carry only a safe next', () => {
    expect(signInHref('/habits?x=1')).toBe('/auth/sign-in?next=%2Fhabits%3Fx%3D1');
    expect(signInHref('https://evil.example')).toBe('/auth/sign-in');
    expect(signUpHref('/goals')).toBe('/auth/sign-up?next=%2Fgoals');
    expect(signUpHref(null)).toBe('/auth/sign-up');
  });
});
