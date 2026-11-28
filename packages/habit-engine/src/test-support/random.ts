/**
 * Seeded pseudo-random inputs for the engine's property tests (ADR-0029: no fast-check
 * dependency). Every run uses the same seeds, so a failure is reproducible: the failing test
 * names its seed, and `property(name, runs, fn)` can be re-run with that seed alone.
 */
import type { CalendarSystem, WeekStart } from '@habit/localization';
import type { HabitScheduleRule } from '@habit/shared-types';
import { formatLocalDate, parseLocalDate } from '../dates.js';
import type { ScheduleInput, SchedulePauseInput, ScheduleVersionInput } from '../schedule.js';

/** mulberry32: small, fast, good enough for test inputs. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export class Gen {
  readonly next: () => number;

  constructor(readonly seed: number) {
    this.next = rng(seed);
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(values: readonly T[]): T {
    return values[this.int(0, values.length - 1)] as T;
  }

  subset<T>(values: readonly T[], min = 1): T[] {
    for (;;) {
      const out = values.filter(() => this.bool());
      if (out.length >= min) return out;
    }
  }

  /** A local date `offset` days from `base` with offset in [min, max]. */
  dateNear(base: string, min: number, max: number): string {
    return formatLocalDate(parseLocalDate(base) + this.int(min, max));
  }

  weekStart(): WeekStart {
    return this.pick(['saturday', 'sunday', 'monday'] as const);
  }

  calendar(): CalendarSystem {
    return this.pick(['gregorian', 'solar_hijri'] as const);
  }

  rule(effectiveFrom: string): HabitScheduleRule {
    switch (this.int(0, 4)) {
      case 0:
        return { kind: 'daily' };
      case 1:
        return { kind: 'weekdays', daysOfWeek: this.subset([1, 2, 3, 4, 5, 6, 7]) };
      case 2: {
        const days = this.subset([1, 2, 15, 28, 29, 30, 31, -1]);
        return { kind: 'monthly_days', daysOfMonth: days };
      }
      case 3:
        return {
          kind: 'interval',
          intervalDays: this.pick([2, 3, 7, 10, 30, 365]),
          anchorDate: this.dateNear(effectiveFrom, -400, 400),
        };
      default: {
        const period = this.pick(['week', 'month'] as const);
        return {
          kind: 'times_per_period',
          period,
          timesPerPeriod: period === 'week' ? this.int(1, 7) : this.int(1, 31),
        };
      }
    }
  }

  /** 1..4 consecutive versions, possibly with gaps, starting near `startsOn`. */
  versions(startsOn: string): ScheduleVersionInput[] {
    const count = this.int(1, 4);
    const out: ScheduleVersionInput[] = [];
    let from = this.dateNear(startsOn, -30, 30);
    for (let i = 0; i < count; i += 1) {
      const last = i === count - 1;
      const to = last && this.bool(0.7) ? null : this.dateNear(from, 1, 200);
      out.push({
        id: `v${i + 1}`,
        effectiveFrom: from,
        effectiveTo: to,
        schedule: this.rule(from),
        graceDays: this.int(0, 7),
        weekStart: this.weekStart(),
        calendar: this.calendar(),
      });
      if (to === null) break;
      from = this.bool(0.8) ? to : this.dateNear(to, 1, 20); // contiguous or a gap
    }
    // Callers must accept any order.
    return this.bool() ? out.reverse() : out;
  }

  pauses(startsOn: string): SchedulePauseInput[] {
    const out: SchedulePauseInput[] = [];
    const count = this.int(0, 4);
    for (let i = 0; i < count; i += 1) {
      const s = this.dateNear(startsOn, -20, 500);
      out.push({ startsOn: s, endsOn: this.bool(0.1) ? null : this.dateNear(s, 0, 40) });
    }
    return out;
  }

  input(): ScheduleInput {
    const startsOn = this.dateNear('2024-06-15', -1500, 1500);
    const endsOn = this.bool(0.3) ? this.dateNear(startsOn, 0, 700) : null;
    const archivedOn = this.bool(0.2) ? this.dateNear(startsOn, 0, 700) : null;
    const from = this.dateNear(startsOn, -40, 300);
    const to = this.dateNear(from, 0, 500);
    return {
      startsOn,
      endsOn,
      archivedOn,
      versions: this.versions(startsOn),
      pauses: this.pauses(startsOn),
      range: { from, to },
    };
  }
}
