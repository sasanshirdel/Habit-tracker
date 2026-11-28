/**
 * `@habit/habit-engine` — pure, deterministic habit logic shared by the API (and, later, the web
 * app's offline mode). Backlog P3-02, ADR-0029: the schedule engine; P3-04, ADR-0031: occurrence
 * statuses and check-in rules. No I/O, no clock, no dependencies but the workspace's type/constant
 * packages.
 */
export {
  addDays,
  dayToGregorian,
  daysBetween,
  ENGINE_DATE_MAX,
  ENGINE_DATE_MIN,
  formatLocalDate,
  gregorianMonthLength,
  gregorianToDay,
  isGregorianLeapYear,
  isLocalDate,
  isoWeekday,
  isoWeekdayOf,
  parseLocalDate,
  type DayNumber,
  type GregorianDate,
} from './dates.js';
export { ScheduleInputError, type ScheduleInputErrorCode } from './errors.js';
export { periodContaining, type PeriodKind, type PeriodOptions } from './periods.js';
export {
  computeSchedule,
  ENGINE_LIMITS,
  LAST_DAY,
  versionIdOn,
  type InactiveReason,
  type ScheduleDay,
  type ScheduleDayState,
  type ScheduleInput,
  type SchedulePauseInput,
  type SchedulePeriod,
  type ScheduleResult,
  type ScheduleRuleState,
  type ScheduleVersionInput,
} from './schedule.js';
export {
  dayToSolarHijri,
  isSolarHijriLeapYear,
  SOLAR_HIJRI_YEAR_MAX,
  SOLAR_HIJRI_YEAR_MIN,
  solarHijriMonthLength,
  solarHijriToDay,
  type SolarHijriDate,
} from './solar-hijri.js';
export {
  checkInRefusal,
  computeStatuses,
  judgeValue,
  statusRecordRange,
  type CheckInAction,
  type CheckInRefusal,
  type DayProgress,
  type DayStatus,
  type DayTiming,
  type PeriodStatus,
  type PeriodStatusValue,
  type StatusInput,
  type StatusRecordInput,
  type StatusResult,
  type StatusVersionInput,
} from './status.js';
export { isTimeZone, localDateAt } from './time-zone.js';
