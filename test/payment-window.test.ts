import { describe, expect, it } from 'vitest';
import { buildInstallmentSchedule } from '../src/services/installment-schedule.service.js';
import { clampDayOfMonth, lastCalendarDayOfMonth } from '../src/utils/payment-window.js';

const BASE = {
  startDate: '2026-01-01T00:00:00+05:30',
  durationMonths: 11,
  monthlyInstallmentPaise: 100_000,
  status: 'ACTIVE' as const,
  paymentWindowType: 'FIXED_DAY' as const,
  fixedPaymentDay: 5,
};

describe('payment window schedule', () => {
  it('treats FIXED_DAY 5 as upcoming on the 4th, due on the 5th, overdue on the 6th', () => {
    const unpaid: [] = [];
    const upcoming = buildInstallmentSchedule(BASE, unpaid, new Date('2026-01-04T12:00:00+05:30'));
    const due = buildInstallmentSchedule(BASE, unpaid, new Date('2026-01-05T12:00:00+05:30'));
    const overdue = buildInstallmentSchedule(BASE, unpaid, new Date('2026-01-06T00:00:00+05:30'));

    expect(upcoming[0]).toMatchObject({ schemeMonth: 1, status: 'UPCOMING', daysOverdue: 0 });
    expect(due[0]).toMatchObject({ schemeMonth: 1, status: 'DUE', daysOverdue: 0 });
    expect(overdue[0]).toMatchObject({ schemeMonth: 1, status: 'OVERDUE' });
    expect(overdue[0]?.daysOverdue).toBeGreaterThanOrEqual(1);
  });

  it('still allows overdue installments to be recorded before month 12', () => {
    const schedule = buildInstallmentSchedule(
      BASE,
      [],
      new Date('2026-03-20T12:00:00+05:30'),
    );
    expect(schedule[0]?.status).toBe('OVERDUE');
    expect(schedule[0]?.canRecord).toBe(true);
    expect(schedule[1]?.canRecord).toBe(true);
  });

  it('never permits recording during month 12', () => {
    const schedule = buildInstallmentSchedule(
      BASE,
      [],
      new Date('2026-12-05T12:00:00+05:30'),
    );
    expect(schedule.every((item) => item.canRecord === false)).toBe(true);
  });

  it('treats DATE_RANGE 1–10 as upcoming before the 1st, due on 1 and 10, overdue on 11', () => {
    const enrollment = {
      ...BASE,
      startDate: '2026-02-01T00:00:00+05:30',
      paymentWindowType: 'DATE_RANGE' as const,
      fixedPaymentDay: undefined,
      paymentWindowStartDay: 1,
      paymentWindowEndDay: 10,
    };
    const before = buildInstallmentSchedule(
      enrollment,
      [],
      new Date('2026-01-31T12:00:00+05:30'),
    );
    const day1 = buildInstallmentSchedule(enrollment, [], new Date('2026-02-01T00:00:00+05:30'));
    const day10 = buildInstallmentSchedule(enrollment, [], new Date('2026-02-10T23:00:00+05:30'));
    const day11 = buildInstallmentSchedule(enrollment, [], new Date('2026-02-11T00:00:00+05:30'));

    expect(before[0]?.status).toBe('UPCOMING');
    expect(day1[0]?.status).toBe('DUE');
    expect(day10[0]?.status).toBe('DUE');
    expect(day11[0]?.status).toBe('OVERDUE');
  });

  it('clamps configured day 31 to February 28 in a non-leap year', () => {
    expect(lastCalendarDayOfMonth(2027, 1)).toBe(28);
    expect(clampDayOfMonth(2027, 1, 31)).toBe(28);
    const schedule = buildInstallmentSchedule(
      {
        ...BASE,
        startDate: '2027-02-01T00:00:00+05:30',
        fixedPaymentDay: 31,
      },
      [],
      new Date('2027-02-28T12:00:00+05:30'),
    );
    expect(schedule[0]?.status).toBe('DUE');
    expect(schedule[0]?.dueDate.toISOString()).toBe('2027-02-27T18:30:00.000Z');
  });

  it('keeps February 29 in a leap year', () => {
    expect(clampDayOfMonth(2028, 1, 29)).toBe(29);
    const schedule = buildInstallmentSchedule(
      {
        ...BASE,
        startDate: '2028-02-01T00:00:00+05:30',
        paymentWindowType: 'DATE_RANGE',
        paymentWindowStartDay: 1,
        paymentWindowEndDay: 29,
        fixedPaymentDay: undefined,
      },
      [],
      new Date('2028-02-29T12:00:00+05:30'),
    );
    expect(schedule[0]?.status).toBe('DUE');
  });

  it('uses Asia/Kolkata calendar boundaries, not UTC', () => {
    const justBefore = buildInstallmentSchedule(
      BASE,
      [],
      new Date('2026-01-04T18:30:00.000Z'),
    );
    const justOn = buildInstallmentSchedule(BASE, [], new Date('2026-01-04T18:30:00.000Z'));
    // 2026-01-04T18:30Z is 2026-01-05 00:00 IST
    expect(justOn[0]?.status).toBe('DUE');
    const stillFourth = buildInstallmentSchedule(
      BASE,
      [],
      new Date('2026-01-04T18:29:59.000Z'),
    );
    expect(stillFourth[0]?.status).toBe('UPCOMING');
    expect(justBefore[0]?.paymentWindowStartDate.toISOString()).toBe('2026-01-04T18:30:00.000Z');
  });

  it('keeps a snapshotted FIXED_DAY window after a later plan would have changed', () => {
    const schedule = buildInstallmentSchedule(
      {
        ...BASE,
        paymentWindowType: 'FIXED_DAY',
        fixedPaymentDay: 5,
        planSnapshot: {
          paymentWindowType: 'DATE_RANGE',
          paymentWindowStartDay: 1,
          paymentWindowEndDay: 10,
        },
      },
      [],
      new Date('2026-01-11T12:00:00+05:30'),
    );
    expect(schedule[0]?.status).toBe('OVERDUE');
  });
});
