import { describe, expect, it } from 'vitest';
import {
  calendarSystems,
  defaultCalendarFor,
  defaultWeekStartFor,
  getIntlCalendar,
  isCalendarSystem,
  isWeekStart,
  locales,
  weekStarts,
} from './index.js';

describe('calendar preferences (P2-07)', () => {
  it('has a default calendar and week start for every locale', () => {
    expect(locales.map(defaultCalendarFor)).toEqual(['gregorian', 'solar_hijri']);
    expect(locales.map(defaultWeekStartFor)).toEqual(['monday', 'saturday']);
  });

  it('maps every calendar to an Intl calendar the runtime supports', () => {
    for (const calendar of calendarSystems) {
      const intl = getIntlCalendar(calendar);
      const resolved = new Intl.DateTimeFormat('en-US', { calendar: intl }).resolvedOptions();
      expect(resolved.calendar).toBe(intl);
    }
  });

  it('formats the same instant in both calendars', () => {
    const instant = new Date('2026-03-21T12:00:00Z'); // Nowruz 1405
    const persian = new Intl.DateTimeFormat('en-US', {
      calendar: getIntlCalendar('solar_hijri'),
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).format(instant);
    expect(persian).toMatch(/^1\/1\/1405/);
  });

  it('guards', () => {
    expect(isCalendarSystem('solar_hijri')).toBe(true);
    expect(isCalendarSystem('persian')).toBe(false);
    expect(isWeekStart('saturday')).toBe(true);
    expect(isWeekStart('friday')).toBe(false);
    expect(weekStarts).toHaveLength(3);
  });
});
