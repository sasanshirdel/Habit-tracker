import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '../i18n/messages';
import {
  appHomeHref,
  isActiveSection,
  mobileMoreSections,
  mobilePrimarySections,
  sectionKeys,
  sections,
} from './sections';

const appDir = join(import.meta.dirname, '..', '..', 'app', '[locale]', '(app)');

describe('primary sections (P1-11, ARCHITECTURE §7)', () => {
  it('lists every PRD §2.3 section once, in the documented order', () => {
    expect(sections.map((s) => s.key)).toEqual([...sectionKeys]);
    expect(new Set(sections.map((s) => s.href)).size).toBe(sections.length);
    const architecture = readFileSync(
      join(import.meta.dirname, '..', '..', '..', '..', 'docs', 'ARCHITECTURE.md'),
      'utf8',
    );
    for (const key of sectionKeys) {
      expect(architecture, key).toContain(messages.en.nav[key]);
    }
  });

  it('gives each section a page in the (app) group and a label in both locales', () => {
    for (const section of sections) {
      expect(existsSync(join(appDir, section.href.slice(1), 'page.tsx')), section.href).toBe(true);
      expect(messages.en.nav[section.key]).toBeTruthy();
      expect(messages.fa.nav[section.key]).toBeTruthy();
      expect(messages.fa.nav[section.key]).not.toBe(messages.en.nav[section.key]);
    }
    expect(appHomeHref).toBe('/overview');
  });

  it('fits the mobile bottom bar: at most four sections plus "More", the rest in the sheet', () => {
    expect(mobilePrimarySections.map((s) => s.key)).toEqual([
      'overview',
      'habits',
      'tasks',
      'planner',
    ]);
    expect(mobilePrimarySections.length + 1).toBeLessThanOrEqual(5);
    expect(mobileMoreSections.map((s) => s.key)).toEqual([
      'goals',
      'focus',
      'journal',
      'insights',
      'coach',
      'settings',
    ]);
  });

  it('mirrors only direction-bearing icons in RTL', () => {
    expect(sections.filter((s) => s.mirrorInRtl).map((s) => s.key)).toEqual(['tasks']);
  });
});

describe('isActiveSection', () => {
  it.each([
    ['/habits', '/habits', true],
    ['/habits/', '/habits', true],
    ['/habits/123', '/habits', true],
    ['/habits/templates', '/habits', true],
    ['/habitsx', '/habits', false],
    ['/', '/overview', false],
    ['/overview', '/habits', false],
    ['/settings/profile', '/settings', true],
  ])('%s in %s → %s', (pathname, href, expected) => {
    expect(isActiveSection(pathname, href)).toBe(expected);
  });
});
