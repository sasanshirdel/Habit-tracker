/** Why an engine input was refused. Callers validate first; these are programming errors. */
export type ScheduleInputErrorCode =
  | 'INVALID_DATE'
  | 'DATE_OUT_OF_WINDOW'
  | 'INVALID_RANGE'
  | 'INVALID_HABIT_DATES'
  | 'INVALID_VERSION'
  | 'OVERLAPPING_VERSIONS'
  | 'INVALID_RULE'
  | 'INVALID_PAUSE'
  | 'INVALID_TIME_ZONE'
  | 'INVALID_INSTANT';

/**
 * Thrown for input the engine cannot compute with (unreal dates, overlapping versions, a rule
 * outside the ADR-0028 bounds, …). The engine never guesses or repairs input: the API validates
 * with `@habit/shared-validation` and the database refuses most of these already, so reaching
 * this error means a bug upstream.
 */
export class ScheduleInputError extends Error {
  override readonly name = 'ScheduleInputError';

  constructor(
    readonly code: ScheduleInputErrorCode,
    message: string,
  ) {
    super(message);
  }
}
