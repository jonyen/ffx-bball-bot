import { describe, test, expect } from 'vitest';
import { parseScheduleInput } from '../src/shared/scheduleParser.js';

describe('parseScheduleInput', () => {
  describe('raw cron/rate/at expressions are no longer accepted', () => {
    test('cron(...) is rejected', () => {
      expect(() => parseScheduleInput('cron(0 8 ? * TUE,THU *)')).toThrow();
    });

    test('rate(...) is rejected', () => {
      expect(() => parseScheduleInput('rate(1 hour)')).toThrow();
    });

    test('bare six-field cron is rejected', () => {
      expect(() => parseScheduleInput('0 8 ? * TUE,THU *')).toThrow();
    });
  });

  describe('natural language — days + time', () => {
    test('every Tuesday and Thursday at 8am', () => {
      const r = parseScheduleInput('every Tuesday and Thursday at 8am');
      expect(r.expression).toBe('cron(0 8 ? * TUE,THU *)');
      expect(r.summary).toBe('every TUE, THU at 8am');
    });

    test('every weekday at 9:30am → MON-FRI', () => {
      const r = parseScheduleInput('every weekday at 9:30am');
      expect(r.expression).toBe('cron(30 9 ? * MON-FRI *)');
      expect(r.summary).toBe('every weekday at 9:30am');
    });

    test('every weekend at 10am → SAT,SUN', () => {
      expect(parseScheduleInput('every weekend at 10am').expression).toBe(
        'cron(0 10 ? * SAT,SUN *)',
      );
    });

    test('every day at noon → dow "*"', () => {
      const r = parseScheduleInput('every day at noon');
      expect(r.expression).toBe('cron(0 12 ? * * *)');
      expect(r.summary).toBe('every day at noon');
    });

    test('every day at midnight', () => {
      expect(parseScheduleInput('every day at midnight').expression).toBe(
        'cron(0 0 ? * * *)',
      );
    });

    test('daily at 6am', () => {
      expect(parseScheduleInput('daily at 6am').expression).toBe(
        'cron(0 6 ? * * *)',
      );
    });

    test('every mon,wed,fri at 7am', () => {
      expect(parseScheduleInput('every mon,wed,fri at 7am').expression).toBe(
        'cron(0 7 ? * MON,WED,FRI *)',
      );
    });

    test('8am every tuesday (order-insensitive)', () => {
      expect(parseScheduleInput('8am every tuesday').expression).toBe(
        'cron(0 8 ? * TUE *)',
      );
    });

    test('5pm converts to 17 in 24h', () => {
      expect(parseScheduleInput('every fri at 5pm').expression).toBe(
        'cron(0 17 ? * FRI *)',
      );
    });

    test('12pm = noon (hour 12)', () => {
      expect(parseScheduleInput('every day at 12pm').expression).toBe(
        'cron(0 12 ? * * *)',
      );
    });

    test('12am = midnight (hour 0)', () => {
      expect(parseScheduleInput('every day at 12am').expression).toBe(
        'cron(0 0 ? * * *)',
      );
    });

    test('plural day names (tuesdays)', () => {
      expect(parseScheduleInput('every tuesdays at 8am').expression).toBe(
        'cron(0 8 ? * TUE *)',
      );
    });

    test('24-hour time with colon', () => {
      expect(parseScheduleInput('every tue 17:30').expression).toBe(
        'cron(30 17 ? * TUE *)',
      );
    });

    test('day prefixes inside longer words do not false-match (tue ≠ tuesday match)', () => {
      // "saturday" should not also match "sat" — word boundaries prevent it.
      // Result should be SAT exactly once.
      const r = parseScheduleInput('every saturday at 10am');
      expect(r.expression).toBe('cron(0 10 ? * SAT *)');
    });
  });

  describe('errors', () => {
    test('empty input throws', () => {
      expect(() => parseScheduleInput('')).toThrow(/empty/i);
      expect(() => parseScheduleInput('   ')).toThrow(/empty/i);
    });

    test('days without a time throws with a helpful hint', () => {
      expect(() => parseScheduleInput('every tuesday')).toThrow(/time/i);
    });

    test('time without days throws with a helpful hint', () => {
      expect(() => parseScheduleInput('at 8am')).toThrow(/days/i);
    });

    test('bogus input throws', () => {
      expect(() => parseScheduleInput('bogus')).toThrow();
    });

    test('bare 8 (no am/pm, no colon) is rejected as ambiguous', () => {
      expect(() => parseScheduleInput('every tuesday at 8')).toThrow(/time/i);
    });
  });

  describe('one-shot rejection (requires "every" or a plural/group alias)', () => {
    test('"Tuesday at 8am" is rejected with a suggested fix', () => {
      expect(() => parseScheduleInput('Tuesday at 8am')).toThrow(/one-shot/i);
      expect(() => parseScheduleInput('Tuesday at 8am')).toThrow(
        /every Tuesday at 8am/,
      );
    });

    test('"mon,wed,fri at 7am" (no every) is rejected', () => {
      expect(() => parseScheduleInput('mon,wed,fri at 7am')).toThrow(/one-shot/i);
    });

    test('"Tue 8pm" is rejected', () => {
      expect(() => parseScheduleInput('Tue 8pm')).toThrow(/one-shot/i);
    });

    test('plural day names count as recurrence markers (no "every" needed)', () => {
      expect(parseScheduleInput('tuesdays at 8am').expression).toBe(
        'cron(0 8 ? * TUE *)',
      );
    });

    test('"daily" counts as a recurrence marker', () => {
      expect(parseScheduleInput('daily at 6am').expression).toBe(
        'cron(0 6 ? * * *)',
      );
    });

    test('"weekdays" counts as a recurrence marker', () => {
      expect(parseScheduleInput('weekdays at 9am').expression).toBe(
        'cron(0 9 ? * MON-FRI *)',
      );
    });
  });
});
