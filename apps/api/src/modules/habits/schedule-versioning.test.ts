import { versionIdOn } from '@habit/habit-engine';
import type { HabitScheduleRule, HabitScheduleVersion, HabitType } from '@habit/shared-types';
import { habitScheduleChangeSchema, type HabitScheduleChangeInput } from '@habit/shared-validation';
import { describe, expect, it } from 'vitest';
import {
  assertPlanResult,
  HabitScheduleChangeError,
  planScheduleChange,
  sameRules,
  snapshotOf,
  toEngineVersion,
  versionsAfter,
  type PlanScheduleChangeInput,
  type SchedulePlan,
} from './schedule-versioning.js';

// Schedule versioning rules (P3-03, ADR-0030), without a database: which plan each change gets,
// what it refuses, and that the planned version set always hands over cleanly in the engine.

const V1 = '0193a3a0-0000-7000-8000-000000000001';
const V2 = '0193a3a0-0000-7000-8000-000000000002';
const NEW = '0193a3a0-0000-7000-8000-0000000000ff';

const version = (over: Partial<HabitScheduleVersion> = {}): HabitScheduleVersion => ({
  id: V1,
  effectiveFrom: '2026-11-01',
  effectiveTo: null,
  schedule: { kind: 'daily' },
  target: null,
  graceDays: 0,
  weekStart: 'monday',
  calendar: 'gregorian',
  createdAt: '2026-11-01T08:00:00.000Z',
  ...over,
});

const settings = { weekStart: 'monday', calendar: 'gregorian' } as const;

function plan(
  request: HabitScheduleChangeInput,
  over: Partial<Omit<PlanScheduleChangeInput, 'request'>> & { type?: HabitType } = {},
): SchedulePlan {
  return planScheduleChange({
    habit: { type: over.type ?? 'binary', startsOn: '2026-11-01', endsOn: null, ...over.habit },
    versions: over.versions ?? [version()],
    today: over.today ?? '2026-11-28',
    settings: over.settings ?? settings,
    request: habitScheduleChangeSchema.parse(request),
  });
}

function refused(fn: () => unknown): HabitScheduleChangeError {
  try {
    fn();
  } catch (error) {
    if (error instanceof HabitScheduleChangeError) return error;
    throw error;
  }
  throw new Error('expected a HabitScheduleChangeError');
}

const weekdays = { kind: 'weekdays', daysOfWeek: [1, 3, 5] } satisfies HabitScheduleRule;
const rules = (schedule: HabitScheduleChangeInput['schedule'] = weekdays) => ({
  schedule,
  target: null,
  graceDays: 0,
});

describe('planScheduleChange (P3-03)', () => {
  it('splits the current version on today by default: closes it the day before', () => {
    const p = plan(rules());
    expect(p).toMatchObject({
      operation: 'split',
      effectiveFrom: '2026-11-28',
      effectiveTo: null,
      isCorrection: false,
      rejudgedUntil: null,
      previous: { id: V1 },
      rules: { schedule: weekdays, weekStart: 'monday', calendar: 'gregorian' },
    });
    const after = versionsAfter([version()], p, NEW, '2026-11-28T10:00:00.000Z');
    expect(after.map((v) => [v.id, v.effectiveFrom, v.effectiveTo])).toEqual([
      [V1, '2026-11-01', '2026-11-28'],
      [NEW, '2026-11-28', null],
    ]);
    const engine = after.map(toEngineVersion);
    expect(versionIdOn(engine, '2026-11-27')).toBe(V1);
    expect(versionIdOn(engine, '2026-11-28')).toBe(NEW);
    expect(() =>
      assertPlanResult(
        { type: 'binary', startsOn: '2026-11-01', endsOn: null },
        p as never,
        after,
        NEW,
      ),
    ).not.toThrow();
  });

  it('defaults to the habit start when the habit has not started yet', () => {
    const p = plan(rules(), {
      habit: { type: 'binary', startsOn: '2026-12-10', endsOn: null },
      versions: [version({ effectiveFrom: '2026-12-10' })],
    });
    expect(p).toMatchObject({
      operation: 'replace',
      effectiveFrom: '2026-12-10',
      isCorrection: false,
    });
  });

  it('a future-dated change splits on that date and keeps today’s rules until then', () => {
    const p = plan({ ...rules(), effectiveFrom: '2027-01-01' });
    expect(p).toMatchObject({
      operation: 'split',
      effectiveFrom: '2027-01-01',
      isCorrection: false,
    });
    const after = versionsAfter([version()], p, NEW, 'x');
    expect(versionIdOn(after.map(toEngineVersion), '2026-12-31')).toBe(V1);
  });

  it('a change inside a closed version runs until the next (already scheduled) version', () => {
    const versions = [
      version({ effectiveTo: '2027-01-01' }),
      version({
        id: V2,
        effectiveFrom: '2027-01-01',
        schedule: { kind: 'monthly_days', daysOfMonth: [1] },
      }),
    ];
    const p = plan({ ...rules(), effectiveFrom: '2026-12-01' }, { versions });
    expect(p).toMatchObject({ operation: 'split', effectiveTo: '2027-01-01' });
    const after = versionsAfter(versions, p, NEW, 'x');
    expect(after.map((v) => [v.id, v.effectiveFrom, v.effectiveTo])).toEqual([
      [V1, '2026-11-01', '2026-12-01'],
      [NEW, '2026-12-01', '2027-01-01'],
      [V2, '2027-01-01', null],
    ]);
    expect(() =>
      assertPlanResult(
        { type: 'binary', startsOn: '2026-11-01', endsOn: null },
        p as never,
        after,
        NEW,
      ),
    ).not.toThrow();
  });

  it('replaces a version that starts on the effective date (same-day rule), keeping its id and range', () => {
    const versions = [
      version({ effectiveTo: '2026-11-28' }),
      version({
        id: V2,
        effectiveFrom: '2026-11-28',
        schedule: { kind: 'monthly_days', daysOfMonth: [1] },
      }),
    ];
    const p = plan(rules(), { versions });
    expect(p).toMatchObject({ operation: 'replace', previous: { id: V2 }, isCorrection: false });
    const after = versionsAfter(versions, p, NEW, 'x');
    expect(after.map((v) => [v.id, v.effectiveFrom, v.effectiveTo, v.schedule.kind])).toEqual([
      [V1, '2026-11-01', '2026-11-28', 'daily'],
      [V2, '2026-11-28', null, 'weekdays'],
    ]);
  });

  it('identical rules (incl. calendar settings) change nothing', () => {
    expect(plan(rules({ kind: 'daily' })).operation).toBe('unchanged');
    // Same rule, but the user's week start changed since: a new version snapshots it.
    expect(
      plan(rules({ kind: 'daily' }), { settings: { weekStart: 'saturday', calendar: 'gregorian' } })
        .operation,
    ).toBe('split');
    expect(
      sameRules(
        { ...version({ schedule: { kind: 'weekdays', daysOfWeek: [5, 1] } }) },
        { ...version({ schedule: { kind: 'weekdays', daysOfWeek: [1, 5] } }) },
      ),
    ).toBe(true);
  });

  it('anchors an interval without anchorDate on the effective date', () => {
    const p = plan({
      ...rules({ kind: 'interval', intervalDays: 3 }),
      effectiveFrom: '2026-12-05',
    });
    expect(p).toMatchObject({
      operation: 'split',
      rules: { schedule: { kind: 'interval', intervalDays: 3, anchorDate: '2026-12-05' } },
    });
    const kept = plan({
      ...rules({ kind: 'interval', intervalDays: 3, anchorDate: '2026-11-02' }),
      effectiveFrom: '2026-12-05',
    });
    expect(kept).toMatchObject({ rules: { schedule: { anchorDate: '2026-11-02' } } });
  });

  it('snapshots the user’s current week start and calendar onto the new version', () => {
    const p = plan(rules({ kind: 'monthly_days', daysOfMonth: [1] }), {
      settings: { weekStart: 'saturday', calendar: 'solar_hijri' },
    });
    expect(p).toMatchObject({ rules: { weekStart: 'saturday', calendar: 'solar_hijri' } });
  });

  describe('historical corrections (effective before today)', () => {
    it('need a reason', () => {
      expect(refused(() => plan({ ...rules(), effectiveFrom: '2026-11-20' })).code).toBe(
        'REASON_REQUIRED',
      );
    });

    it('split with a reason, re-judging [effectiveFrom, today)', () => {
      const p = plan({ ...rules(), effectiveFrom: '2026-11-20', reason: '  Wrong days  ' });
      expect(p).toMatchObject({
        operation: 'split',
        isCorrection: true,
        reason: 'Wrong days',
        rejudgedUntil: '2026-11-28',
      });
    });

    it('re-judge only up to the next version when it starts before today', () => {
      const versions = [
        version({ effectiveTo: '2026-11-15' }),
        version({ id: V2, effectiveFrom: '2026-11-15', schedule: weekdays }),
      ];
      const p = plan(
        {
          ...rules({ kind: 'monthly_days', daysOfMonth: [3] }),
          effectiveFrom: '2026-11-05',
          reason: 'x',
        },
        { versions },
      );
      expect(p).toMatchObject({
        operation: 'split',
        effectiveTo: '2026-11-15',
        rejudgedUntil: '2026-11-15',
      });
    });

    it('replace the first version from the habit start', () => {
      const p = plan({ ...rules(), effectiveFrom: '2026-11-01', reason: 'Set up wrongly' });
      expect(p).toMatchObject({
        operation: 'replace',
        isCorrection: true,
        rejudgedUntil: '2026-11-28',
      });
    });
  });

  it('refuses dates outside the habit’s life', () => {
    expect(refused(() => plan({ ...rules(), effectiveFrom: '2026-10-31', reason: 'x' })).code).toBe(
      'EFFECTIVE_BEFORE_START',
    );
    expect(
      refused(() =>
        plan(
          { ...rules(), effectiveFrom: '2026-12-31' },
          {
            habit: { type: 'binary', startsOn: '2026-11-01', endsOn: '2026-12-30' },
          },
        ),
      ).code,
    ).toBe('EFFECTIVE_AFTER_END');
    // An ended habit has no default "today" either.
    expect(
      refused(() =>
        plan(rules(), { habit: { type: 'binary', startsOn: '2026-11-01', endsOn: '2026-11-10' } }),
      ).code,
    ).toBe('EFFECTIVE_AFTER_END');
  });

  it('refuses rules that do not fit the stored habit type', () => {
    const error = refused(() =>
      plan(rules({ kind: 'times_per_period', period: 'week', timesPerPeriod: 3 })),
    );
    expect(error.code).toBe('INVALID_RULES');
    expect(error.issues[0]?.path).toEqual(['schedule', 'kind']);
    expect(
      refused(() =>
        plan({ schedule: { kind: 'daily' }, target: null, graceDays: 0 }, { type: 'numeric' }),
      ).code,
    ).toBe('INVALID_RULES');
  });

  it('refuses when no version covers the date, or the stored versions overlap', () => {
    expect(
      refused(() =>
        plan(
          { ...rules(), effectiveFrom: '2026-12-01' },
          {
            versions: [version({ effectiveTo: '2026-11-20' })],
          },
        ),
      ).code,
    ).toBe('NO_VERSION_ON_DATE');
    expect(
      refused(() =>
        plan(rules(), {
          versions: [version(), version({ id: V2, effectiveFrom: '2026-11-10' })],
        }),
      ).code,
    ).toBe('INVALID_VERSIONS');
  });

  it('assertPlanResult catches a version set that does not hand over on the date', () => {
    const p = plan(rules());
    const broken = [
      version({ effectiveTo: '2026-11-27' }),
      version({ id: NEW, effectiveFrom: '2026-11-28' }),
    ];
    expect(
      refused(() =>
        assertPlanResult(
          { type: 'binary', startsOn: '2026-11-01', endsOn: null },
          p as never,
          broken,
          NEW,
        ),
      ).code,
    ).toBe('INVALID_VERSIONS');
  });

  it('snapshots drop only createdAt', () => {
    const { createdAt, ...rest } = version();
    expect(createdAt).toBeTypeOf('string');
    expect(snapshotOf(version())).toEqual(rest);
  });

  it('never moves a past day to another version unless the change is a correction (seeded)', () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    const dates = Array.from({ length: 60 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 10, 1 + i));
      return d.toISOString().slice(0, 10);
    });
    for (let run = 0; run < 300; run++) {
      // A random contiguous version history, then a random change.
      let versions = [version({ graceDays: next() % 8 })];
      const today = dates[10 + (next() % 40)]!;
      for (let step = 0; step < 4; step++) {
        const from = dates[next() % dates.length]!;
        const request = {
          schedule: { kind: 'weekdays' as const, daysOfWeek: [1 + (next() % 7)] },
          target: null,
          graceDays: next() % 8,
          effectiveFrom: from,
          ...(next() % 2 === 0 ? { reason: 'fix' } : {}),
        };
        let p: SchedulePlan;
        try {
          p = plan(request, { versions, today });
        } catch (error) {
          expect(error).toBeInstanceOf(HabitScheduleChangeError);
          continue;
        }
        const id = `0193a3a0-0000-7000-9000-${String(run * 10 + step).padStart(12, '0')}`;
        const after = versionsAfter(versions, p, id, 'x');
        const before = versions.map(toEngineVersion);
        const engine = after.map(toEngineVersion);
        for (const day of dates) {
          const was = versionIdOn(before, day);
          const now = versionIdOn(engine, day);
          if (day < (p.isCorrection ? p.effectiveFrom : today)) {
            expect(now, `${day} kept its version`).toBe(was);
            if (p.operation === 'replace' && was === p.previous.id && !p.isCorrection) {
              throw new Error('replace of a version that covers a past day must be a correction');
            }
          }
          expect(now, `${day} still covered`).not.toBeNull();
        }
        versions = after;
      }
    }
  });
});
