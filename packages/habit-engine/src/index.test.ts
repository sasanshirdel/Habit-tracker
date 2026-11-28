import { describe, expect, it } from 'vitest';
import * as engine from './index.js';

describe('public surface', () => {
  it('exports exactly the documented runtime API (README, ADR-0029, ADR-0031)', () => {
    expect(Object.keys(engine).sort()).toEqual(
      [
        'addDays',
        'checkInRefusal',
        'computeStatuses',
        'judgeValue',
        'statusRecordRange',
        'computeSchedule',
        'dayToGregorian',
        'dayToSolarHijri',
        'daysBetween',
        'ENGINE_DATE_MAX',
        'ENGINE_DATE_MIN',
        'ENGINE_LIMITS',
        'formatLocalDate',
        'gregorianMonthLength',
        'gregorianToDay',
        'isGregorianLeapYear',
        'isLocalDate',
        'isoWeekday',
        'isoWeekdayOf',
        'isSolarHijriLeapYear',
        'isTimeZone',
        'LAST_DAY',
        'localDateAt',
        'parseLocalDate',
        'periodContaining',
        'ScheduleInputError',
        'SOLAR_HIJRI_YEAR_MAX',
        'SOLAR_HIJRI_YEAR_MIN',
        'solarHijriMonthLength',
        'solarHijriToDay',
        'versionIdOn',
      ].sort(),
    );
  });
});
